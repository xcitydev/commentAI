
const { App, ExpressReceiver } = require("@slack/bolt");

require("dotenv").config();
const { ApifyClient } = require("apify-client");
const { createClient } = require("@deepgram/sdk");
const { GoogleGenAI } = require("@google/genai");
const fetch = require("node-fetch");
const { TEAM_SOP } = require("./team_sop");

const queue = [];
let isProcessing = false;
const PORT = process.env.PORT || 8080; 
let botUserId = process.env.SLACK_BOT_USER_ID || null;
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

receiver.router.get("/health", (_, res) => {
  res.status(200).send("OK");
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});



/**
 * @param {string} url 
 * @returns {string} 
 */
function normalizeInstagramUrl(url) {
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  const questionMarkIndex = url.indexOf("?");
  if (questionMarkIndex !== -1) {
    url = url.substring(0, questionMarkIndex);
  }

  return url;
}

/**
 * @param {string} url 
 * @returns {Promise<object>} 
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
 * @param {string} videoUrl 
 * @returns {Promise<string>} 
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

const PROCESSING_DELAY = 15000;

/**
 
 * @param {string} imageUrl 
 * @returns {Promise<object>} 
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

 * @param {object} params 
 * @param {string} params.caption 
 * @param {string} [params.transcription] 
 * @param {object} [params.imageData] 
 * @param {string} [params.ownerFullName]
 * @param {number} [params.numComments=5] 
 * @returns {Promise<string>} - 
 */
async function generateComment({
  caption,
  transcription,
  imageData,
  ownerFullName,
  numComments,
  language
}) {
  console.log("Generating comment with Gemini...");
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const numberOfComments = numComments || 5; 

  let promptParts = [];

  let fullPromptText = `${TEAM_SOP}\n\n`;

  if (language !== "english") {
    fullPromptText += `\n\nGenerate all comments in ${language}. Do not translate the instructions, only the comments should be in ${language}.`;
  }

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

  fullPromptText += `GENERATION DIRECTIVES:
- Create ${numComments} organic Instagram comments
- Sound like a real person who just viewed this post
- Be specific to these details:
${ownerFullName ? `- Post creator: ${ownerFullName}\n` : ""}
- CAPTION: "${caption}"

- MUST FOLLOW ALL RULES IN SOP
- OUTPUT FORMAT: Only comments separated by blank lines`;

  fullPromptText += `\n\nDo NOT include any introductory sentence or numbering in your response. Provide only the comments, each on a new line with an empty line inbetween each comment. 
  FINAL CHECKLIST (DO NOT SKIP):

✅ Comments are directly relevant to the post
✅ All comments look like they’re from real people
✅ Comments don’t repeat or feel templated
✅ Tone is chill, casual, and varied
✅ Submission format is clean and double spaced
`;

  if (transcription) {
    fullPromptText += `\nVideo Transcription:\n"${transcription}"`;
    promptParts.push({ text: fullPromptText });
  } else if (imageData && imageData.data && imageData.mimeType) {
    fullPromptText += `\nAnalyze the provided image and caption.`;
    promptParts.push(
      { text: fullPromptText },
      { inlineData: { mimeType: imageData.mimeType, data: imageData.data } }
    );
  } else {
    promptParts.push({ text: fullPromptText });
  }

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
 
 * @param {string} url 
 * @param {string} channelId 
 * @param {string} threadTs 
 * @param {function} client 
 * @param {string} userId 
 * @param {number} numComments 
 */
async function generateCommentForLink(
  url,
  channelId,
  threadTs,
  client,
  userId,
  numComments,
  language
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
      language: language
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

    console.error("Full processing error:", error);

    let userMessage = `Sorry <@${userId}>, I couldn't process that link. `;

    if (error.message.includes("Post not found")) {
      userMessage += "The post might be private or unavailable.";
    } else if (error.message.includes("transcription error")) {
      userMessage += "I had trouble with the video audio.";
    } else if (error.message.includes("Gemini")) {
      userMessage += "Our comment system had an issue.";
    } else {
      userMessage += "Please try a different post.";
    }

    await client.chat.postMessage({
      channel: channelId,
      text: userMessage,
      thread_ts: threadTs,
    });
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

async function processQueue() {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const { url, channelId, threadTs, client, userId, numComments, language } =
    queue.shift();

  try {
    await generateCommentForLink(
      url,
      channelId,
      threadTs,
      client,
      userId,
      numComments,
      language
    );
  } catch (error) {
    console.error("Queue processing error:", error);
  }

  // Add delay before next processing
  await new Promise((resolve) => setTimeout(resolve, 15000));
  isProcessing = false;
  processQueue();
}

// --- Event Listeners ---

const instagramUrlWithNumberRegex =
  /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[\w-]+[^?\s]*)(?:\s+(\d+))?/i;
const MAX_COMMENTS = 60;

const SUPPORTED_LANGUAGES = [
  "english",
  "spanish",
  "french",
  "german",
  "portuguese",
  "italian",
];
// Updated handleInstagramLinkMessage function
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

    // Clean up URL formatting
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

    // Normalize the Instagram URL
    instagramUrl = normalizeInstagramUrl(instagramUrl);

    console.log("Processing Instagram link:", instagramUrl);
    console.log("Number of comments to generate:", numComments);

    // Add task to queue
    const queuePosition = queue.length + 1;
    queue.push({
      url: instagramUrl,
      channelId,
      threadTs,
      client,
      userId,
      numComments,
    });

    // Notify user about queue position
    let queueMessage = `<@${userId}>: Your Instagram link has been added to the queue. `;

    if (queuePosition === 1) {
      queueMessage += "I'll start processing it immediately! ⏱️";
    } else {
      queueMessage += `Position in queue: ${queuePosition}. Estimated wait time: ${Math.round(
        (queuePosition * PROCESSING_DELAY) / 1000
      )} seconds.`;
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: queueMessage,
      thread_ts: threadTs,
    });

    // Start processing if not already running
    if (!isProcessing) {
      processQueue();
    }
  } else {
    // Handle non-link messages
    const lowerText = messageText.toLowerCase();

    if (lowerText.includes("hello") || lowerText.includes("hi")) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Hey <@${userId}>! 👋 Send me an Instagram link to generate comments (add a number like "link 5" for custom amount).`,
        thread_ts: threadTs,
      });
    } else if (lowerText.includes("how are you")) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Doing great, thanks for asking! 😊 Ready to generate comments whenever you send an Instagram link.`,
        thread_ts: threadTs,
      });
    } else if (lowerText.includes("status") || lowerText.includes("queue")) {
      const statusMessage =
        queue.length === 0
          ? "✅ No links in queue. Send me an Instagram link!"
          : `📊 Current queue status:\n${queue
              .map(
                (item, index) =>
                  `${index + 1}. ${item.url} (${item.numComments} comments)`
              )
              .join("\n")}`;

      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: statusMessage,
        thread_ts: threadTs,
      });
    }
    // No response for other messages
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
