// Import the Bolt App class from the @slack/bolt package
const { App } = require("@slack/bolt");
// Import the ngrok package
const ngrok = require("@ngrok/ngrok");
// Load environment variables from .env file
require("dotenv").config(); // This line is crucial for loading .env variables

// Import external SDKs for Instagram scraping, transcription, and AI generation
const { ApifyClient } = require("apify-client");
const { createClient } = require("@deepgram/sdk");
// Using your specified GoogleGenAI import
const { GoogleGenAI } = require("@google/genai");
const fetch = require("node-fetch"); // Required for downloading images. Ensure node-fetch@2 is installed for CommonJS.

// Import the TEAM_SOP constant from its separate file
const { TEAM_SOP } = require("./team_sop"); // Adjust path if you put it in a subdirectory like './constants/team_sop'

// Define the port your local server will listen on.
const PORT = process.env.PORT || 3000;

// Declare a variable to store the bot's user ID, directly populated from environment variable
// This assumes SLACK_BOT_USER_ID is set in your .env or environment
let botUserId = process.env.SLACK_BOT_USER_ID || null;

// Initialize the Bolt App
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
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
    .actor(process.env.INSTAGRAM_SCRAPER_ACTOR) // Renamed from NEXT_PUBLIC_INSTAGRAM_SCRAPER_ACTOR
    .call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  if (!items.length) {
    throw new Error("Post not found or inaccessible by Apify.");
  }

  // Apify's Instagram scraper usually returns type 'GraphImage' for posts and 'GraphVideo' for reels
  return {
    caption: items[0].caption,
    imageUrl: items[0].imageUrl,
    videoUrl: items[0].videoUrl,
    ownerFullName: items[0].ownerFullName,
    linkType: items[0].type, // Include linkType to differentiate posts from reels
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
    const mimeType = response.headers.get("content-type") || "image/jpeg"; // Fallback MIME type

    return {
      mimeType: mimeType.split(";")[0], // Clean up potential charset info
      data: buffer.toString("base64"),
    };
  } catch (error) {
    console.error(
      `Error downloading or converting image to base64: ${error.message}`
    );
    return null; // Return null if image download or conversion fails
  }
}

/**
 * Generates comments using Google Gemini API, adapting input based on content type.
 * @param {object} params - Parameters for comment generation.
 * @param {string} params.caption - Instagram post caption.
 * @param {string} [params.transcription] - Video transcription (optional).
 * @param {object} [params.imageData] - { mimeType: string, data: string } Base64 image data (optional).
 * @param {string} [params.ownerFullName] - The full name of the post owner.
 * @returns {Promise<string>} - The generated comments as a single string.
 */
async function generateComment({
  caption,
  transcription,
  imageData,
  ownerFullName,
}) {
  console.log("Generating comment with Gemini...");
  // Using your specified GoogleGenAI import and instantiation
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const numberOfComments = 5; // Generate a reasonable number of comments for Slack

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
 * Handles the end-to-end process of generating comments for a given Instagram link
 * and posting them as a thread reply in Slack.
 * @param {string} url - The Instagram link.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} threadTs - The Slack message timestamp for threading.
 * @param {function} client - The Slack WebClient instance.
 * @param {string} userId - The ID of the user who sent the link.
 */
async function generateCommentForLink(
  url,
  channelId,
  threadTs,
  client,
  userId
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
    } else if (postData.imageUrl && postData.linkType === "Image") {
      console.log(
        "Detected image post, attempting to download image for analysis..."
      );
      // Only proceed if imageUrl is a string and looks like a valid URL
      if (
        typeof postData.imageUrl === "string" &&
        postData.imageUrl.startsWith("http")
      ) {
        imageData = await downloadImageAsBase64(postData.imageUrl);
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
    });

    // --- Formatting generated comments ---
    // Split comments by newlines and filter out empty lines.
    // The prompt is now designed to prevent leading numbers or introductory phrases,
    // but this cleanup is still useful as a safeguard.
    const rawCommentLines = comments
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) =>
        line
          .replace(
            /^\s*\d+\.\s*|\s*^\s*\d+\)\s*|^Here are \d+ Instagram comments.*:|^Comments:\s*/i,
            ""
          )
          .trim()
      ) // Strip common prefixes
      .filter((line) => line.length > 0); // Ensure lines are not empty after stripping

    // Add numbering and an extra newline between each comment
    const formattedComments = rawCommentLines
      .map((line, index) => `${index + 1}. ${line}`)
      .join("\n\n"); // Changed from '\n' to '\n\n' for extra line space
    // --- End Formatting ---

    // Post the generated comments as a reply in the thread
    await client.chat.postMessage({
      channel: channelId,
      // Add the desired introductory sentence
      text: `Hey <@${userId}>, here are some generated comments for the Instagram post:\n\nHere are ${rawCommentLines.length} Instagram comments designed to be organic and engaging, based on the provided post details and adhering to the SOP:\n\n${formattedComments}`, // Added extra \n before formattedComments
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

// Listen for messages that mention your bot (e.g., "@yourbot hello")
app.event("app_mention", async ({ event, say }) => {
  console.log("Received app_mention event (mention):", event);
  const messageText = event.text;
  const userId = event.user;
  const channelId = event.channel;
  const threadTs = event.ts; // Get the timestamp of the message to thread replies

  const instagramUrlRegex =
    /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[\w-]+\/?)/i;
  const match = messageText.match(instagramUrlRegex);

  if (match) {
    const instagramUrl = match[1];
    // Acknowledge the event immediately
    await say({
      text: `Got your mention with an Instagram link! Starting comment generation for ${instagramUrl}...`,
      thread_ts: threadTs, // Reply in thread
    });
    // Run the heavy lifting asynchronously
    generateCommentForLink(
      instagramUrl,
      channelId,
      threadTs,
      app.client,
      userId
    );
  } else if (messageText.toLowerCase().includes("hello")) {
    await say({
      text: `Hello there, <@${userId}>! You mentioned me!`,
      thread_ts: threadTs,
    });
  } else {
    await say({
      text: `I heard your mention, <@${userId}>: "${messageText}". Try sending an Instagram link!`,
      thread_ts: threadTs,
    });
  }
});

// Listen for ANY message in a channel the bot is in (not just mentions)
app.message(async ({ message, say }) => {
  // Ignore messages from bots to prevent infinite loops (especially important if reading all messages)
  if (
    message.subtype === "bot_message" ||
    message.subtype === "message_changed" ||
    message.subtype === "message_deleted" ||
    message.subtype === "channel_join" ||
    message.subtype === "channel_leave"
  ) {
    return;
  }
  // Ignore messages if they are an app_mention, as that's handled by app.event('app_mention')
  // Ensure botUserId is populated from environment variable before checking against it
  if (botUserId && message.text && message.text.includes(`<@${botUserId}>`)) {
    return;
  }

  console.log("Received message event (general):", message);

  const messageText = message.text;
  const userId = message.user;
  const channelId = message.channel;
  const threadTs = message.ts; // Get the timestamp of the message to thread replies

  const instagramUrlRegex =
    /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[\w-]+\/?)/i;
  const match = messageText.match(instagramUrlRegex);

  if (match) {
    const instagramUrl = match[1];
    // Send an immediate acknowledgment to the user
    await app.client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `Got your Instagram link! Starting comment generation for ${instagramUrl}...`,
      thread_ts: threadTs, // Reply in thread
    });

    // Run the heavy lifting asynchronously
    generateCommentForLink(
      instagramUrl,
      channelId,
      threadTs,
      app.client,
      userId
    );
  } else if (messageText && messageText.toLowerCase().includes("hi")) {
    await say({
      text: `Hi there, <@${userId}>! I saw your message in <#${channelId}>. Send me an Instagram link to get comments!`,
      thread_ts: threadTs,
    });
  } else if (messageText && messageText.toLowerCase().includes("how are you")) {
    await say({
      text: `I'm doing well, thank you for asking, <@${userId}>! Send me an Instagram link!`,
      thread_ts: threadTs,
    });
  } else {
    // Optionally, if you don't want the bot to be too chatty for every message:
    // console.log(`No specific action for message: "${messageText}"`);
  }
});

// Listen for a specific slash command (e.g., /echo [text])
// This requires an HTTP endpoint, which will be provided by ngrok.
app.command("/echo", async ({ command, ack, say }) => {
  await ack();
  console.log("Received slash command:", command);

  const inputText = command.text;
  const userId = command.user_id;
  const channelId = command.channel_id;
  const threadTs = command.ts; // Slash commands also have a timestamp for threading

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

// --- Start the App ---

(async () => {
  try {
    // Start the Bolt app, listening for HTTP requests on the specified PORT.
    // This is necessary for slash commands and interactive components.
    await app.start(PORT);
    console.log(`⚡️ Bolt app HTTP server is running on port ${PORT}!`);

    // We can log the botUserId here if it was successfully loaded from the environment
    if (botUserId) {
      console.log(`Bot user ID loaded from environment: ${botUserId}`);
    } else {
      // Fallback: If botUserId was not set in env, fetch it via API call
      const authTestResult = await app.client.auth.test();
      botUserId = authTestResult.user_id;
      console.log(`Bot user ID fetched via API: ${botUserId}`);
    }

    // Connect to ngrok to create a public URL for your local HTTP server.
    // Ensure NGROK_AUTHTOKEN is set as an environment variable.
    const listener = await ngrok.connect({
      addr: PORT,
      authtoken_from_env: true,
    });
    const publicUrl = listener.url();
    console.log(`🎉 ngrok tunnel established at: ${publicUrl}`);
    console.log(
      `👉 Use this URL (${publicUrl}/slack/events and ${publicUrl}/slack/commands) in your Slack App settings.`
    );

    console.log(
      "Remember: Event Subscriptions for general messages will work via Socket Mode (no ngrok needed for those HTTP events)."
    );
    console.log(
      "You will need this ngrok URL for Slash Commands and Interactive Components."
    );
  } catch (error) {
    console.error("Failed to start Bolt app or ngrok tunnel:", error);
  }
})();
