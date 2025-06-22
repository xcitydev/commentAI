// app.js (This file will be deployed as a Google Cloud Run service)

// Import the Bolt App and ExpressReceiver classes
const { App, ExpressReceiver } = require("@slack/bolt");
// Load environment variables from .env file for local development ONLY.
// On Google Cloud Run, environment variables are set directly in the service settings.
require("dotenv").config();

// Import external SDKs for Instagram scraping, transcription, and AI generation
const { ApifyClient } = require("apify-client");
const { createClient } = require("@deepgram/sdk");
// Using your specified GoogleGenAI import
const { GoogleGenAI } = require("@google/genai");
const fetch = require("node-fetch"); // Required for downloading images. Ensure node-fetch@2 is installed for CommonJS.

// Import the TEAM_SOP constant from its separate file
// Ensure team_sop.js is located in the same directory as this app.js file in your deployment bundle.
const { TEAM_SOP } = require("./team_sop");

// Define the port your local server will listen on.
// Cloud Run injects the PORT environment variable.
const PORT = process.env.PORT || 8080; // Default to 8080 as a common Cloud Run port

// Declare a variable to store the bot's user ID.
// This will be populated after the app starts listening.
let botUserId = process.env.SLACK_BOT_USER_ID || null;

// Initialize the ExpressReceiver first.
// This will create an Express app internally that handles incoming HTTP requests from Slack.
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // processBeforeResponse: true is recommended for serverless functions
  // to acknowledge Slack requests quickly while async work continues.
  processBeforeResponse: true,
});

// Initialize the Bolt App using the receiver.
// appToken and socketMode are NOT used for Cloud Run as it's HTTP-based.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});

// --- Core Comment Generation Logic (Adapted from your Next.js API route) ---

/**
 * Scrapes Instagram post data using Apify.
 * @param {string} url - The Instagram post URL.
 * @returns {Promise<object>} - Object containing caption, imageUrl, videoUrl, etc.
 */
async function scrapeInstagramPost(url) {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const input = {
    directUrls: [url],
    resultsType: "posts",
    resultsLimit: 1,
    addParentData: false,
  };

  console.log(`Scraping Instagram post: ${url}`);
  const run = await client
    .actor(process.env.INSTAGRAM_SCRAPER_ACTOR)
    .call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  if (!items.length) {
    throw new Error("Post not found or inaccessible by Apify.");
  }

  return {
    caption: items[0].caption,
    imageUrl: items[0].imageUrl,
    videoUrl: items[0].videoUrl,
    ownerFullName: items[0].ownerFullName,
    linkType: items[0].type,
    displayUrl: items[0].displayUrl,
  };
}

/**
 * Transcribes video from a URL using Deepgram.
 * @param {string} videoUrl - The URL of the video to transcribe.
 * @returns {Promise<string>} - The transcription text.
 */
async function transcribeVideo(videoUrl) {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

  console.log(`Transcribing video: ${videoUrl}`);
  const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
    { url: videoUrl },
    {
      model: "nova-2",
      smart_format: true,
      language: "en-US",
      paragraphs: true,
    }
  );

  if (error) {
    throw new Error(`Deepgram transcription error: ${error.message}`);
  }
  const transcription = result.results.channels[0].alternatives[0].transcript;
  console.log("Transcription: ", transcription);
  return transcription;
}

/**
 * Downloads an image from a URL and converts it to a Base64 string.
 * @param {string} imageUrl - The URL of the image.
 * @returns {Promise<object>} - An object with mimeType and base64 data, or null if failed.
 */
async function downloadImageAsBase64(imageUrl) {
  try {
    console.log(`Downloading image for Gemini: ${imageUrl}`);
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = response.headers.get("content-type") || "image/jpeg";

    return {
      mimeType: mimeType.split(";")[0],
      data: buffer.toString("base64"),
    };
  } catch (error) {
    console.error(
      `Error downloading or converting image to base64: ${error.message}`
    );
    return null;
  }
}

/**
 * Generates comments using Google Gemini API, adapting input based on content type.
 * @param {object} params - Parameters for comment generation.
 * @param {string} params.caption - Instagram post caption.
 * @param {string} [params.transcription] - Video transcription (optional).
 * @param {object} [params.imageData] - { mimeType: string, data: string } Base64 image data (optional).
 * @param {string} [params.ownerFullName] - The full name of the post owner.
 * @param {number} [params.numComments=5] - The number of comments to generate.
 * @returns {Promise<string>} - The generated comments as a single string.
 */
async function generateComment({
  caption,
  transcription,
  imageData,
  ownerFullName,
  numComments,
}) {
  console.log("Generating comment with Gemini...");
  // Using your specified GoogleGenAI import and instantiation
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const numberOfComments = numComments || 5; // Generate a reasonable number of comments for Slack

  let promptParts = [];

  // Prepend TEAM_SOP to the main prompt text
  let fullPromptText = `${TEAM_SOP}\n\n`;

  // Build the main prompt text
  fullPromptText += `Based on the provided Instagram post details, generate ${numberOfComments} highly organic and specific comments.`;

  if (ownerFullName) {
    fullPromptText += ` The post owner's name is: ${ownerFullName}.`;
  }

  fullPromptText += `\n\nDo NOT include any introductory sentence or numbering in your response. Provide only the comments, each on a new line.`;

  fullPromptText += `\n\nCaption: "${caption}"`;

  if (transcription) {
    fullPromptText += `\nVideo Transcription:\n"${transcription}"`;
    promptParts.push({ text: fullPromptText });
  } else if (imageData && imageData.data && imageData.mimeType) {
    // For image posts, add prompt text and image data as separate parts
    fullPromptText += `\nAnalyze the provided image and caption.`;
    promptParts.push(
      { text: fullPromptText },
      { inlineData: { mimeType: imageData.mimeType, data: imageData.data } }
    );
  } else {
    // Fallback if no video or image data, just use caption
    promptParts.push({ text: fullPromptText });
  }

  // Use the model you specified: gemini-2.0-flash
  const response = await genAI.models.generateContent({
    model: "gemini-2.0-flash",
    contents: promptParts,
    config: {
      systemInstruction: `${TEAM_SOP}`,
    },
  });

  const text = response.text;
  console.log("Generated text:", text);
  return text;
}

/**
 * A helper function to retry an async operation with exponential backoff.
 * @param {function} operation - The async function to retry.
 * @param {number} retries - The number of retries left.
 * @param {number} delay - The current delay in milliseconds.
 * @returns {Promise<any>} The result of the operation.
 */
async function retryOperation(operation, retries = 3, delay = 1000) {
  try {
    return await operation();
  } catch (error) {
    if (retries > 0) {
      console.warn(
        `Retry attempt ${retries} failed for operation. Retrying in ${delay}ms... Error: ${error.message}`
      );
      await new Promise((res) => setTimeout(res, delay));
      return retryOperation(operation, retries - 1, delay * 2); // Exponential backoff
    } else {
      throw error; // No retries left, throw the error
    }
  }
}

/**
 * Handles the end-to-end process of generating comments for a given Instagram link
 * and posting them as a thread reply in Slack.
 * @param {string} url - The Instagram link.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} threadTs - The Slack message timestamp for threading.
 * @param {function} client - The Slack WebClient instance.
 * @param {string} userId - The ID of the user who sent the link.
 * @param {number} numComments - The number of comments to generate.
 */
async function generateCommentForLink(
  url,
  channelId,
  threadTs,
  client,
  userId,
  numComments
) {
  let ephemeralMessageTs = null; // Initialize to null

  try {
    // Send an ephemeral "thinking" message
    const ephemeralResponse = await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `<@${userId}>: I'm processing your Instagram link (${url}). This might take a moment... ⏳`,
      thread_ts: threadTs,
    });

    // Only store the timestamp if the ephemeral message was successfully sent
    if (ephemeralResponse.ok) {
      ephemeralMessageTs = ephemeralResponse.message_ts;
    } else {
      console.warn(
        `Failed to send initial ephemeral message: ${ephemeralResponse.error}`
      );
    }

    const postData = await scrapeInstagramPost(url);

    let transcription = "";
    let imageData = null; // To store Base64 image data for Gemini

    // Determine content type and prepare input for Gemini
    if (postData.videoUrl && postData.linkType === "Video") {
      console.log("Detected video post, attempting transcription...");
      transcription = await transcribeVideo(postData.videoUrl);
    } else if (
      postData.linkType === "Sidecar" ||
      postData.linkType === "Image"
    ) {
      console.log(
        "Detected image post, attempting to download image for analysis..."
      );
      // Only proceed if imageUrl is a string and looks like a valid URL
      if (
        typeof postData.displayUrl === "string" &&
        postData.displayUrl.startsWith("http")
      ) {
        imageData = await downloadImageAsBase64(postData.displayUrl);

        if (!imageData) {
          console.warn(
            "Image download failed for image post, proceeding without image analysis."
          );
          // You might choose to throw an error here, or just proceed without image context
        }
      } else {
        console.warn(
          "Invalid image URL found for image post, proceeding without image analysis."
        );
      }
    } else {
      console.log(
        `Detected unsupported or unknown post type (Link Type: ${
          postData.linkType || "unknown"
        }), proceeding with caption only.`
      );
    }

    const comments = await generateComment({
      caption: postData.caption,
      transcription: transcription,
      imageData: imageData, // Pass image data if available
      ownerFullName: postData.ownerFullName, // Pass owner name
      numComments: numComments,
    });

    // --- Formatting generated comments ---
    // Split comments by newlines and filter out empty lines.
    // The prompt is now designed to prevent leading numbers or introductory phrases,
    // but this cleanup is still useful as a safeguard.
    const rawCommentLines = comments
      .split("\n")
      .filter((line) => line.trim() !== "") // Filter out empty lines
      .map((line) => line.trim()); // Trim whitespace from each line

    // Join comments with two newlines for spacing, WITHOUT numbering
    const finalCommentsOutput = rawCommentLines.join("\n\n");
    // --- End Formatting ---

    // Post the generated comments as a reply in the thread
    await client.chat.postMessage({
      channel: channelId,
      // Removed introductory text and numbering
      text: finalCommentsOutput,
      thread_ts: threadTs, // This makes it a thread reply
    });

    // Delete the ephemeral "thinking" message ONLY if it was successfully sent initially
    if (ephemeralMessageTs) {
      try {
        await client.chat.delete({
          channel: channelId,
          ts: ephemeralMessageTs,
        });
      } catch (deleteError) {
        console.warn(
          `Failed to delete ephemeral message: ${deleteError.message}`
        );
        // Log the warning but don't re-throw, as comment was already posted
      }
    }

    console.log(`Successfully generated and posted comments for ${url}`);
  } catch (error) {
    console.error("Error in generateCommentForLink:", error);
    const errorMessage = `Sorry, <@${userId}>, I couldn't generate comments for that link. Error: \`${error.message}\` 😔`;

    // Attempt to post an error message in the thread
    await client.chat.postMessage({
      channel: channelId,
      text: errorMessage,
      thread_ts: threadTs,
    });
    // Delete the ephemeral "thinking" message ONLY if it was successfully sent initially
    if (ephemeralMessageTs) {
      try {
        await client.chat.delete({
          channel: channelId,
          ts: ephemeralMessageTs,
        });
      } catch (deleteError) {
        console.warn(
          `Failed to delete ephemeral message during error handling: ${deleteError.message}`
        );
      }
    }
  }
}

// --- Event Listeners ---

const instagramUrlWithNumberRegex =
  /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[\w-]+\/?)(?:\s+(\d+))?/i;
const MAX_COMMENTS = 20;

async function handleInstagramLinkMessage(
  messageText,
  userId,
  channelId,
  threadTs,
  client
) {
  const match = messageText.match(instagramUrlWithNumberRegex);

  if (match) {
    const instagramUrl = match[1];
    // The number is in match[2] (group 2)
    const numString = match[2]; 
    
    let numComments = 5; // Default to 5 comments
    
    if (numString) {
      const parsedNum = parseInt(numString, 10);
      if (!isNaN(parsedNum)) {
        if (parsedNum >= 1 && parsedNum <= MAX_COMMENTS) {
          numComments = parsedNum;
        } else {
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: `Number must be between 1 and ${MAX_COMMENTS}. Using default 5 comments.`,
            thread_ts: threadTs,
          });
        }
      }
    }

    // Acknowledge the event/message
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `Got your Instagram link! Starting generation of ${numComments} comments for ${instagramUrl}...`,
      thread_ts: threadTs,
    });

    // Run the heavy lifting asynchronously
    generateCommentForLink(
      instagramUrl,
      channelId,
      threadTs,
      client,
      userId,
      numComments
    );
  } else {
    if (
      messageText.toLowerCase().includes("hello") ||
      messageText.toLowerCase().includes("hi")
    ) {
      await client.chat.postMessage({
        text: `Hello there, <@${userId}>! Send me an Instagram link (with an optional number like 'link 5') to get comments!`,
        thread_ts: threadTs,
      });
    } else if (messageText.toLowerCase().includes("how are you")) {
      await client.chat.postMessage({
        text: `I'm doing well, thank you for asking, <@${userId}>! Send me an Instagram link to get comments!`,
        thread_ts: threadTs,
      });
    } else {
    }
  }
}

app.event("app_mention", async ({ event, say }) => {
  console.log("Received app_mention event (mention):", event);
  const messageText = event.text;
  const userId = event.user;
  const channelId = event.channel;
  const threadTs = event.ts;

  handleInstagramLinkMessage(
    messageText,
    userId,
    channelId,
    threadTs,
    app.client
  );
});

app.message(async ({ message, say }) => {
  if (
    message.subtype === "bot_message" ||
    message.subtype === "message_changed" ||
    message.subtype === "message_deleted" ||
    message.subtype === "channel_join" ||
    message.subtype === "channel_leave"
  ) {
    return;
  }
  if (botUserId && message.text && message.text.includes(`<@${botUserId}>`)) {
    return;
  }

  console.log("Received message event (general):", message);

  const messageText = message.text;
  const userId = message.user;
  const channelId = message.channel;
  const threadTs = message.ts;

  handleInstagramLinkMessage(
    messageText,
    userId,
    channelId,
    threadTs,
    app.client
  );
});

app.command("/echo", async ({ command, ack, say }) => {
  await ack();
  console.log("Received slash command:", command);

  const inputText = command.text;
  const userId = command.user_id;
  const channelId = command.channel_id;
  const threadTs = command.ts;

  if (inputText) {
    await say({
      text: `Echoing for <@${userId}>: "${inputText}"`,
      thread_ts: threadTs,
    });
    console.log(`Echoed "${inputText}" in channel ${channelId}.`);
  } else {
    await say({
      text: `Please provide some text to echo, <@${userId}>. Example: \`/echo hello world\``,
      thread_ts: threadTs,
    });
    console.log(`Prompted <@${userId}> for text in channel ${channelId}.`);
  }
});

// --- Main execution block for Cloud Run ---
// This part starts the HTTP server and listens for requests.
(async () => {
  try {
    if (!botUserId) {
      const authTestResult = await app.client.auth.test();
      botUserId = authTestResult.user_id;
      console.log(`Bot user ID fetched via API: ${botUserId}`);
    } else {
      console.log(`Bot user ID loaded from environment: ${botUserId}`);
    }

    await app.start(PORT);
    console.log(
      `⚡️ Bolt app is listening on port ${PORT} for Cloud Run requests!`
    );
    console.log(
      "Ensure your Slack App's Request URLs point to your Cloud Run service URL."
    );
  } catch (error) {
    console.error("Failed to start Bolt app on Cloud Run:", error);
    process.exit(1);
  }
})();
