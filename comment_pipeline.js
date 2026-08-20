const { TEAM_SOP } = require("./team_sop");

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","when","while","of","at","by","for","with","about","against","between","into","through","during","before","after","above","below","to","from","up","down","in","out","on","off","over","under","again","further","once","here","there","all","any","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","can","will","just","don","should","now","is","are","was","were","be","been","being","have","has","had","having","do","does","did","doing","this","that","these","those","i","you","he","she","it","we","they","me","him","her","us","them","my","your","his","its","our","their","what","which","who","whom","whose","how","why","where","yes","really","also","get","got","one","two","new","like","would","could","much","many","make","made","think","thought","know","knew","see","saw","say","said","use","used","take","took","them","their","there","they're","that's","it's","i'm","i've","don't","doesn't","won't","can't","isn't","aren't","wasn't","weren't","haven't","hasn't","hadn't","wouldn't","couldn't","shouldn't"
]);

const ALLOWED_EMOJIS = new Set([
  "👏","🙌","🤌","👍","🔥","😂","🤣","🤩","💯","🚀","💪","🐐","🕊","🙏","👌","🤙"
]);

const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

function extractEmojis(text) {
  const matches = text.match(EMOJI_REGEX);
  return matches || [];
}

function stripVariationSelectors(e) {
  return e.replace(/[︎️‍]/g, "");
}

function hasNonAllowedEmoji(text) {
  const emojis = extractEmojis(text);
  for (const e of emojis) {
    const bare = stripVariationSelectors(e);
    if (!ALLOWED_EMOJIS.has(bare) && !ALLOWED_EMOJIS.has(e)) return true;
  }
  return false;
}

function hasBannedTemplateShape(text) {
  const t = text.trim();
  if (/^(the|that|these|those)\s+[\w'-]+(?:\s+[\w'-]+){0,4}\s+(is|are|feels|felt|looks|looked|was|were)\s+/i.test(t)) return true;
  if (/^[\w'-]+(?:\s+[\w'-]+){0,3}\s+creates?\s+/i.test(t)) return true;
  if (/^[\w'-]+(?:\s+[\w'-]+){0,3}\s+starts?\s+with\s+/i.test(t)) return true;
  if (/^[\w'-]+(?:\s+[\w'-]+){0,3}\s+is\s+the\s+standard/i.test(t)) return true;
  return false;
}

const BANNED_WORDS = [
  "insane","unreal","iconic","unmatched","breathtaking","perfection","absolutely","truly","beyond","literally","definitely","mind-blowing","flawless","masterpiece","gorgeous","obsessed","stunning","captivating","magnificent","exquisite","phenomenal","spectacular","incredible","amazing","awesome"
];

const BANNED_MULTIWORD = [
  "next level","hits different","game changer","game-changer","on point","on another level","real deal","goes hard","brings the heat","for the win","this hits","hit different"
];

function hasBannedWord(text) {
  const t = text.toLowerCase();
  for (const w of BANNED_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, "i");
    if (re.test(t)) return true;
  }
  for (const p of BANNED_MULTIWORD) {
    if (t.includes(p)) return true;
  }
  return false;
}

const BANNED_PHRASES = [
  "you're right","you are right","agreed!","sent you a dm","dming you","dm me",
  "thanks for sharing","thank you for sharing","worth sharing","must buy","must be sharing",
  "will be there","see you at","count me in","won't miss","wouldn't miss",
  "saving this","sharing this","gonna sell","going to sell","pending immediately",
  "can't argue","not a bad idea","great option","good option",
  "great post","good post","great reminder","good reminder","great advice","good advice",
  "great perspective","good perspective","great point","good point","great content","good content",
  "good to know","makes sense","helpful info","real helpful","real talk","too real",
  "worth checking out","checking this out","smart solution","so relatable","so true","so real",
  "well said","couldn't have said","couldn't agree","completely agree","completely aligned",
  "captured my thoughts","valuable post","valuable info","valuable advice","informative post","really informative",
  "keep preaching","keep it up","keep sharing","facts over feelings","facts only",
  "dream home","love the layout","love the vibe","love this vibe","love the setup",
  "great option to have","great chemistry","great job","nice job","nice work",
  "queen","king","royalty","this is everything","this is amazing","this is beautiful",
  "this is powerful","this is inspiring","this is encouraging","this is timely",
  "this is helpful","this is needed","this is real","this is a must","this is genius",
  "this is what","this is where","this is why","this is how","this is when",
  "well deserved","well earned","well put","so wonderfully","so beautifully"
];

function hasBannedPhrase(text) {
  const t = text.toLowerCase();
  return BANNED_PHRASES.some(p => t.includes(p));
}

const VAGUE_STARTERS = [
  "great ","good ","nice ","cool ","amazing ","perfect ","awesome ","beautiful ","powerful ",
  "such a ","what a ","so ","really ","truly ","absolutely ","totally "
];

function isVaguePraiseOnly(text, anchors) {
  const t = text.toLowerCase().trim();
  if (t.length > 30) return false;
  if (commentContainsAnchor(text, anchors)) return false;
  if (SHORT_FLAT_RE.test(text.trim())) return false;
  return VAGUE_STARTERS.some(v => t.startsWith(v));
}

function extractAnchors(caption, transcription, ownerFullName) {
  const anchors = new Set();
  const text = [caption || "", transcription || ""].join(" ");
  if (!text.trim()) return [];

  const numMatches = text.match(/\b\d+(?:[,.]\d+)*(?:%|k|m|st|nd|rd|th)?\b/gi);
  if (numMatches) numMatches.slice(0, 8).forEach(n => anchors.add(n.toLowerCase()));

  const quoteMatches = text.match(/["""''`]([^"""''`]{3,80})["""''`]/g);
  if (quoteMatches) {
    quoteMatches.slice(0, 6).forEach(q => {
      const inner = q.replace(/["""''`]/g, "").trim();
      if (inner.length >= 3) anchors.add(inner.toLowerCase());
    });
  }

  const hashtags = text.match(/#[\w]{3,}/g);
  if (hashtags) hashtags.slice(0, 6).forEach(h => anchors.add(h.slice(1).toLowerCase()));

  const mentions = text.match(/@[\w.]{3,}/g);
  if (mentions) mentions.slice(0, 6).forEach(m => anchors.add(m.slice(1).toLowerCase()));

  const sentences = text.split(/[.!?\n]+/);
  sentences.forEach(s => {
    const words = s.trim().split(/\s+/);
    words.forEach((w, i) => {
      if (i === 0) return;
      const clean = w.replace(/[^\w'-]/g, "");
      if (clean.length < 3) return;
      if (/^[A-Z][a-z]{2,}$/.test(clean) && !STOPWORDS.has(clean.toLowerCase())) {
        anchors.add(clean.toLowerCase());
      }
    });
  });

  const tokens = text.toLowerCase().match(/\b[a-z][a-z'-]{4,}\b/g) || [];
  const freq = new Map();
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  const topTokens = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(e => e[0]);
  topTokens.forEach(t => anchors.add(t));

  if (ownerFullName) {
    const firstName = ownerFullName.split(/\s+/)[0];
    if (firstName && firstName.length >= 3 && /^[A-Z][a-z]+$/.test(firstName)) {
      anchors.add(firstName.toLowerCase());
    }
  }

  return [...anchors].slice(0, 30);
}

function commentContainsAnchor(comment, anchors) {
  if (!anchors || !anchors.length) return false;
  const c = comment.toLowerCase();
  return anchors.some(a => {
    if (a.length < 3) return false;
    if (a.includes(" ")) return c.includes(a);
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}`, "i").test(c)) return true;
    if (a.length >= 6) {
      const stem = a.slice(0, a.length - 3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${stem}[a-z]{0,5}\\b`, "i").test(c)) return true;
    }
    return false;
  });
}

const PERSONAL_START_RE = /^(i['\s]|i've |i have |i'd |my |never (thought|realized|expected|knew|considered)|just |first time |the way |feels like |reminds me |sounds like |makes me |going to give|gonna give|respect for|sometimes |it['s]?\s*crazy how|crazy how)/i;

const SHORT_FLAT_RE = /^(love this|great tip|good tip|powerful episode|powerful|noted|wow|so good|solid|good stuff|preach|true|facts|real|makes me think|this is fire|fire|deep|damn|respect|noted that|got it)([\s\p{Extended_Pictographic}]+)?!?$/iu;

function hasSpecificitySignal(comment, anchors) {
  if (commentContainsAnchor(comment, anchors)) return true;
  if (PERSONAL_START_RE.test(comment.trim())) return true;
  return false;
}

function normalizeForDedup(text) {
  return text
    .toLowerCase()
    .replace(EMOJI_REGEX, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccardSim(a, b) {
  const wa = new Set(normalizeForDedup(a).split(" ").filter(Boolean));
  const wb = new Set(normalizeForDedup(b).split(" ").filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  wa.forEach(w => { if (wb.has(w)) inter++; });
  return inter / (wa.size + wb.size - inter);
}

function isNearDuplicate(a, b, threshold = 0.7) {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = Math.min(na.length, nb.length);
  if (shorter < 6) return na === nb;
  return jaccardSim(a, b) >= threshold;
}

class RecentCommentsMemory {
  constructor(maxSize = 800) {
    this.maxSize = maxSize;
    this.entries = [];
    this.normSet = new Set();
  }
  isDuplicate(comment) {
    const norm = normalizeForDedup(comment);
    if (!norm) return false;
    if (this.normSet.has(norm)) return true;
    const window = this.entries.slice(-150);
    return window.some(e => isNearDuplicate(e, comment, 0.75));
  }
  add(comment) {
    const norm = normalizeForDedup(comment);
    if (!norm || this.normSet.has(norm)) return;
    this.normSet.add(norm);
    this.entries.push(comment);
    if (this.entries.length > this.maxSize) {
      const removed = this.entries.shift();
      this.normSet.delete(normalizeForDedup(removed));
    }
  }
  addMany(comments) {
    for (const c of comments) this.add(c);
  }
  recentSample(n = 40) {
    return this.entries.slice(-n);
  }
}

const recentMemory = new RecentCommentsMemory(800);

function isEmojiOnly(comment) {
  const stripped = comment.replace(EMOJI_REGEX, "").replace(/\s/g, "");
  return stripped.length === 0 && comment.trim().length > 0;
}

function hasTextAndEmoji(comment) {
  return /\p{L}/u.test(comment) && EMOJI_REGEX.test(comment);
}

function stripNumbering(line) {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
}

function stripSurroundingQuotes(line) {
  const t = line.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function splitRawIntoComments(text, expectedCount) {
  let raw = text.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  if (raw.length < Math.max(3, Math.floor(expectedCount / 2))) {
    raw = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  }
  return raw.map(stripNumbering).map(stripSurroundingQuotes).filter(Boolean);
}

function enforceStructure(kept, numComments) {
  const maxExclaim = Math.max(2, Math.ceil(numComments * 0.3));
  let exclaimCount = 0;
  const result = [];
  let prev = null;

  for (const original of kept) {
    let c = original;

    if (c.endsWith("!")) {
      const prevEndsBang = prev && prev.endsWith("!");
      if (exclaimCount >= maxExclaim || prevEndsBang) {
        c = c.replace(/!+\s*$/, "").trim();
      } else {
        exclaimCount++;
      }
    }

    c = c.replace(/!!+/g, "!");

    const cIsEmojiOnly = isEmojiOnly(c);
    const cHasTextAndEmoji = hasTextAndEmoji(c);
    const prevIsEmojiOnly = prev && isEmojiOnly(prev);
    const prevHasTextAndEmoji = prev && hasTextAndEmoji(prev);

    if (cIsEmojiOnly && prevIsEmojiOnly) continue;
    if (cHasTextAndEmoji && prevHasTextAndEmoji) {
      c = c.replace(EMOJI_REGEX, "").trim();
      if (!c) continue;
    }

    if (!c) continue;
    result.push(c);
    prev = c;
  }

  return result;
}

function buildPrompt({ caption, transcription, imageData, ownerFullName, numComments, language, anchors, loosenPunctuation, avoidComments }) {
  const anchorList = anchors && anchors.length
    ? anchors.slice(0, 20).map(a => `"${a}"`).join(", ")
    : "(no explicit anchors extracted — you must find and reference specific details yourself)";

  const puncRules = loosenPunctuation
    ? `- ONE period mid-thought is allowed (e.g. "20 years is no joke. That takes real work"). Never end a comment with a period.
- ONE comma per comment is allowed. Still no comma directly before a name.
- "we"/"us" is allowed when reflecting on shared human experience (e.g. "Sometimes we really do forget to breathe").`
    : `- NO full stops (periods) anywhere.
- NO commas.
- NEVER use "we" or "us".`;

  const avoidBlock = avoidComments && avoidComments.length
    ? `\n\n## DO NOT REPEAT OR PARAPHRASE THESE (already used before):\n${avoidComments.slice(0, 50).map(c => `- ${c}`).join("\n")}`
    : "";

  const maxBang = Math.max(2, Math.ceil(numComments * 0.3));

  return `${TEAM_SOP}

===============================
## HARD RULES FOR THIS BATCH
===============================

You are writing ${numComments} Instagram comments for a post by ${ownerFullName || "the creator"}.

The #1 failure mode we are fixing: generic AI-sounding comments that could be pasted under any post. Every comment must feel like a real person who just watched THIS post.

## ANCHORS (specific details pulled from this post)
Reference at least ONE of these in ~65% of the comments (exact word or close paraphrase):
${anchorList}

If a comment doesn't reference an anchor, it MUST use a first-person hook like "I've actually…", "Never thought about…", "Never realized…", "The way you…", "Reminds me of…". No floating generic praise.

## COMMENT ARCHETYPES (mix them — no more than 3 of the same type in a row)
1. QUOTE-AND-REACT — paraphrase a line/idea, then react briefly.
   Ex: "Would drink a bottle of wine to get through the day… that's rough. Glad she found her way out🙏"
2. PERSONAL EXPERIENCE — first-person, tie to your own life.
   Ex: "I've actually started doing box breathing before stressful meetings"
3. NEW REALIZATION — "Never thought about…", "Never realized…"
   Ex: "Never thought about addiction as being addicted to 'more' instead of one thing"
4. SPECIFIC OBSERVATION — a concrete detail (visual, phrase, moment).
   Ex: "She looks so different now, in a good way🙏"
5. OUTSIDE KNOWLEDGE — a related fact or connection.
   Ex: "I've heard athletes do this too"
6. TWO-BEAT — observation + brief reaction, one internal break.
   Ex: "20 years is no joke. That takes real work 💪"
7. FRAMING PRAISE — compliment a specific idea/way it was said, not the person.
   Ex: "Surrender not being the same as giving up is a good way to put it"
8. SHORT FLAT REACTION — sparingly, MAX 2 across the batch.
   Ex: "Great tip", "Powerful episode 👏"

## HARD BANS (never generate these)
- Template shapes: "The [noun] is [adj]", "That [noun] is [adj]" (e.g. "The design is amazing", "That kitchen is gorgeous")
- Fortune-cookie shapes: "[abstract] creates [abstract]" (e.g. "Discipline creates consistency"), "[X] starts with [Y]"
- Stating the obvious about the topic (e.g. "College tuition is wild", "Growth never really stops", "Kids are pricey")
- Floating vague praise (e.g. "Great perspective", "This is encouraging", "So relatable", "Real helpful", "Makes sense", "Well said", "Good to know", "Worth checking out")
- AI-tell words: insane, unreal, next level, iconic, unmatched, breathtaking, perfection, absolutely, truly, beyond, literally, definitely, mind-blowing, flawless, masterpiece, stunning, gorgeous, obsessed, incredible, amazing, awesome
- Banned SOP phrases: "You're right", "Agreed!", "I would…", "Saving this", "Sent you a DM", "Thanks for sharing", "Will be there", "Count me in"
- Non-yellow emojis. STRICTLY forbidden: ❤️ 💔 💖 🤍 💜 💙 💚 🖤 😍 🥰 🥺 🚨 💥 ✅ ❌ ⭐ 🏆 🎉 ✨ 🫶 💕 💞 💗
- Slang like "Gorggg", "Obsesseddd", triple-letter drawls

## APPROVED EMOJIS (yellow-toned only, use sparingly and only when they fit)
👏 🙌 🤌 👍 🔥 😂 🤣 🤩 💯 🚀 💪 🐐 🕊 🙏 👌

## PUNCTUATION FOR THIS BATCH
${puncRules}
- Max ${maxBang} comments ending in "!" across the whole batch.
- Never two consecutive comments ending in "!".
- Never "!!" or "‼️".

## STRUCTURE
- ${numComments} UNIQUE comments — no exact repeats, no near-duplicates, no rephrasings of each other.
- Comment length: mostly 4–14 words. A few longer two-beat comments are fine.
- No numbering, no bullets, no intro line, no outro line.
- Separate each comment with ONE blank line.
- No consecutive emoji-only lines.
- No consecutive text-with-emoji lines.

## CONTEXT
- Creator: ${ownerFullName || "unknown"}
- CAPTION: "${caption || "(none)"}"
${transcription ? `- VIDEO TRANSCRIPT: "${transcription}"\n` : ""}${imageData ? "- IMAGE: attached — analyze concrete visual details (objects, colors, setting, actions) and reference them in specific comments.\n" : ""}${language && language !== "english" ? `\n## LANGUAGE\nWrite all comments in ${language}. Do not translate the rules; translate only the output.\n` : ""}${avoidBlock}

Now produce exactly ${numComments} comments. Nothing else — no preamble, no closing, no numbering.`;
}

async function callGemini({ genAI, prompt, imageData }) {
  const parts = [{ text: prompt }];
  if (imageData && imageData.data && imageData.mimeType) {
    parts.push({ inlineData: { mimeType: imageData.mimeType, data: imageData.data } });
  }
  const response = await genAI.models.generateContent({
    model: "gemini-2.5-flash",
    contents: parts,
    config: { systemInstruction: TEAM_SOP },
  });
  return response.text || "";
}

function evaluateComment(comment, ctx) {
  const { anchors, keptSoFar, shortFlatUsed } = ctx;

  if (!comment || comment.length < 3) return { ok: false, reason: "too-short" };
  if (comment.length > 240) return { ok: false, reason: "too-long" };
  if (/^\s*(here (are|is)|below|these are|comments?:)/i.test(comment)) return { ok: false, reason: "preamble" };

  if (hasNonAllowedEmoji(comment)) return { ok: false, reason: "non-yellow-emoji" };
  if (hasBannedTemplateShape(comment)) return { ok: false, reason: "template-shape" };
  if (hasBannedWord(comment)) return { ok: false, reason: "banned-word" };
  if (hasBannedPhrase(comment)) return { ok: false, reason: "banned-phrase" };
  if (isVaguePraiseOnly(comment, anchors)) return { ok: false, reason: "vague-praise" };

  const stripped = comment.replace(EMOJI_REGEX, "").trim();
  const isEmojiLine = stripped.length === 0;

  if (!isEmojiLine && !hasSpecificitySignal(comment, anchors)) {
    if (SHORT_FLAT_RE.test(comment.trim()) && shortFlatUsed < 2) {
      return { ok: true, isShortFlat: true };
    }
    return { ok: false, reason: "no-specificity" };
  }

  for (const k of keptSoFar) {
    if (isNearDuplicate(k, comment)) return { ok: false, reason: "batch-dup" };
  }
  if (recentMemory.isDuplicate(comment)) return { ok: false, reason: "cross-post-dup" };

  return { ok: true, isShortFlat: false };
}

async function generateFilteredComments({ caption, transcription, imageData, ownerFullName, numComments, language }) {
  const { GoogleGenAI } = require("@google/genai");
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const anchors = extractAnchors(caption, transcription, ownerFullName);
  const loosenPunctuation = numComments > 30;

  console.log(`[pipeline] Requested: ${numComments}, loosen=${loosenPunctuation}, anchors=${anchors.length}`);

  const kept = [];
  const rejectedSamples = [];
  let shortFlatUsed = 0;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts && kept.length < numComments; attempt++) {
    const need = numComments - kept.length;
    const askFor = Math.min(180, Math.max(need + 5, Math.ceil(need * 1.5)));

    const avoidList = [
      ...kept,
      ...rejectedSamples.slice(-25),
      ...recentMemory.recentSample(30),
    ];

    const prompt = buildPrompt({
      caption, transcription, imageData, ownerFullName,
      numComments: askFor,
      language,
      anchors,
      loosenPunctuation,
      avoidComments: avoidList,
    });

    let raw;
    try {
      const text = await callGemini({ genAI, prompt, imageData });
      raw = splitRawIntoComments(text, askFor);
    } catch (err) {
      console.error(`[pipeline] Gemini call failed on attempt ${attempt}:`, err.message);
      if (attempt === maxAttempts) throw err;
      continue;
    }

    console.log(`[pipeline] Attempt ${attempt}: asked for ${askFor}, got ${raw.length} raw`);

    const reasonCounts = {};
    for (const candidate of raw) {
      if (kept.length >= numComments) break;
      const result = evaluateComment(candidate, { anchors, keptSoFar: kept, shortFlatUsed });
      if (result.ok) {
        kept.push(candidate);
        if (result.isShortFlat) shortFlatUsed++;
      } else {
        reasonCounts[result.reason] = (reasonCounts[result.reason] || 0) + 1;
        if (rejectedSamples.length < 100) rejectedSamples.push(candidate);
      }
    }
    console.log(`[pipeline] Attempt ${attempt}: kept ${kept.length}/${numComments}, rejects:`, reasonCounts);
  }

  const finalOrdered = enforceStructure(kept.slice(0, numComments), numComments);
  recentMemory.addMany(finalOrdered);

  console.log(`[pipeline] Final: ${finalOrdered.length} comments delivered`);
  return finalOrdered;
}

module.exports = {
  generateFilteredComments,
  evaluateComment,
  extractAnchors,
  commentContainsAnchor,
  hasSpecificitySignal,
  hasNonAllowedEmoji,
  hasBannedTemplateShape,
  hasBannedWord,
  hasBannedPhrase,
  isVaguePraiseOnly,
  isNearDuplicate,
  normalizeForDedup,
  jaccardSim,
  enforceStructure,
  splitRawIntoComments,
  RecentCommentsMemory,
  recentMemory,
  ALLOWED_EMOJIS,
  BANNED_WORDS,
  BANNED_PHRASES,
};
