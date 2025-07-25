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

// Add health check endpoint for Cloud Run
receiver.router.get("/health", (_, res) => {
  res.status(200).send("OK");
});

// Initialize the Bolt App using the receiver.
// appToken and socketMode are NOT used for Cloud Run as it's HTTP-based.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});

// --- Core Comment Generation Logic ---

/**
 * Normalizes an Instagram URL by removing trailing slashes and query parameters
 * @param {string} url - The Instagram URL to normalize
 * @returns {string} - Cleaned URL
 */
function normalizeInstagramUrl(url) {
  // Remove trailing slash
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  // Remove query parameters
  const questionMarkIndex = url.indexOf("?");
  if (questionMarkIndex !== -1) {
    url = url.substring(0, questionMarkIndex);
  }

  return url;
}

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
  fullPromptText += `Based on the provided Instagram post details, generate ${numberOfComments} highly organic and specific comments.  Ensure the comments strictly adhere to the following:
 
  1. No full stops ('.') at the end of any comment.
  2. A strict maximum of 5-7 exclamation marks ('!') across all 20 comments.
  3. No consecutive emoji-only comments (e.g., three lines of just emojis in a row).
  4. No consecutive text comments that both have attached emojis.
  5. No consecutive comments ending with an exclamation mark.
  6. No names appearing back-to-back, sentences can't start with a name e.g David is a good guy.
  7. Use human first names (if applicable) in 2-3 comments, without a comma before the name.
  8. Do NOT use names if they are not unequivocally common human first names (e.g., brand names like 'K3soundzAtl').
  9. No exaggeration or overhyping.
  10. If adding a an emoji to a text dont add more than 1 emoji and only do not more than 3 of this type when asked of 10
  11. Do not reuse emojies E.g 1. 🙌🙌🙌 2. Let's go 🙌🙌
  12. Do not use ✨, 🫶 in any comment
  13. Some comments should be straight or brief to the point.
  15. Some comments should be more personal and relatable.
  16. In any case you feel like this emoji is needed "👍" replace it with this "🤩"
  17. Never put an exclamation mark at the end of an emoji (text +emoji comments or emoji only comments).
  18. Never use the author name at the beginning of a comment.
  
  `;

  if (ownerFullName) {
    fullPromptText += ` The post owner's name is: ${ownerFullName}.`;
  }

  fullPromptText += `\n\nDo NOT include any introductory sentence or numbering in your response. Provide only the comments, each on a new line with an empty line inbetween each comment. 
  FINAL CHECKLIST (DO NOT SKIP):

✅ Comments are directly relevant to the post
✅ All comments look like they’re from real people
✅ Comments don’t repeat or feel templated
✅ Tone is chill, casual, and varied
✅ Submission format is clean and double spaced

Use this format every time unless new post-specific instructions are provided. This is the master command for all laid-back comment batches.`;

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
    model: "gemini-2.5-flash",
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
  let timeoutWarning = null; // For long-running operation warning

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

    // Set timeout warning for long operations
    timeoutWarning = setTimeout(async () => {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `This is taking longer than expected. Still working on it...`,
          thread_ts: threadTs,
        });
      } catch (warningError) {
        console.warn("Failed to send timeout warning:", warningError);
      }
    }, 15000); // 15-second warning

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
    console.log("Comments:", comments);

    const commentBlocks = comments
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block !== "");

    // Join with double newlines to create separation
    const finalCommentsOutput = commentBlocks.join("\n\n");
    // --- End Formatting ---

    // Post the generated comments as a reply in the thread
    await client.chat.postMessage({
      channel: channelId,
      text: finalCommentsOutput,
      thread_ts: threadTs, // This makes it a thread reply
    });

    // Clear the timeout warning if it hasn't triggered yet
    clearTimeout(timeoutWarning);

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
      }
    }

    console.log(
      `Successfully generated and posted ${numComments} comments for ${url}`
    );
  } catch (error) {
    console.error("Error in generateCommentForLink:", error);
    // Clear timeout on error
    if (timeoutWarning) clearTimeout(timeoutWarning);

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
  /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[\w-]+[^?\s]*)(?:\s+(\d+))?/i;
const MAX_COMMENTS = 60;

async function handleInstagramLinkMessage(
  messageText,
  userId,
  channelId,
  threadTs,
  client
) {
  const match = messageText.match(instagramUrlWithNumberRegex);

  console.log("Message text:", messageText);
  console.log("Regex match:", match);

  if (match) {
    let instagramUrl = match[1];
    let numComments = 5;

    if (instagramUrl.endsWith(">")) {
      instagramUrl = instagramUrl.slice(0, -1);
    }

    // Enhanced number extraction
    let numString = match[2];

    // Check if URL itself ends with digits
    if (!numString) {
      const urlEndMatch = instagramUrl.match(/(\d+)$/);
      if (urlEndMatch && urlEndMatch[1]) {
        numString = urlEndMatch[1];
        // Remove numbers from URL
        instagramUrl = instagramUrl.slice(0, -numString.length);
      }
    }

    // Parse the number if found
    if (numString) {
      const parsedNum = parseInt(numString, 10);
      console.log("Parsed number:", parsedNum);

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

    console.log("Instagram URL:", instagramUrl);
    // Normalize the Instagram URL
    instagramUrl = normalizeInstagramUrl(instagramUrl);

    console.log("Processing Instagram link:", instagramUrl);
    console.log("Number of comments to generate:", numComments);

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
      // Optionally respond to other messages
      // console.log(`No action taken for message: "${messageText}"`);
    }
  }
}

app.event("app_mention", async ({ event, client }) => {
  console.log("Received app_mention event (mention):", event);
  const messageText = event.text;
  const userId = event.user;
  const channelId = event.channel;
  const threadTs = event.ts;

  handleInstagramLinkMessage(messageText, userId, channelId, threadTs, client);
});

app.message(async ({ message, client }) => {
  if (
    message.subtype === "bot_message" ||
    message.subtype === "message_changed" ||
    message.subtype === "message_deleted" ||
    message.subtype === "channel_join" ||
    message.subtype === "channel_leave"
  ) {
    return;
  }

  // Ensure botUserId is populated before checking
  if (!botUserId) {
    try {
      const authTestResult = await client.auth.test();
      botUserId = authTestResult.user_id;
      console.log(`Bot user ID fetched via API: ${botUserId}`);
    } catch (error) {
      console.error("Failed to fetch bot user ID:", error);
      return;
    }
  }

  if (message.text && message.text.includes(`<@${botUserId}>`)) {
    return;
  }

  console.log("Received message event (general):", message);

  const messageText = message.text;
  const userId = message.user;
  const channelId = message.channel;
  const threadTs = message.ts;

  handleInstagramLinkMessage(messageText, userId, channelId, threadTs, client);
});

app.command("/echo", async ({ command, ack, client }) => {
  await ack();
  console.log("Received slash command:", command);

  const inputText = command.text;
  const userId = command.user_id;
  const channelId = command.channel_id;
  const threadTs = command.ts;

  if (inputText) {
    await client.chat.postMessage({
      channel: channelId,
      text: `Echoing for <@${userId}>: "${inputText}"`,
      thread_ts: threadTs,
    });
    console.log(`Echoed "${inputText}" in channel ${channelId}.`);
  } else {
    await client.chat.postMessage({
      channel: channelId,
      text: `Please provide some text to echo, <@${userId}>. Example: \`/echo hello world\``,
      thread_ts: threadTs,
    });
    console.log(`Prompted <@${userId}> for text in channel ${channelId}.`);
  }
});

// --- Main execution block for Cloud Run ---
(async () => {
  try {
    // First attempt to get botUserId from API if not in env
    if (!botUserId) {
      try {
        const authTestResult = await app.client.auth.test();
        botUserId = authTestResult.user_id;
        console.log(`Bot user ID fetched via API: ${botUserId}`);
      } catch (error) {
        console.error("Failed to fetch bot user ID:", error);
      }
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
