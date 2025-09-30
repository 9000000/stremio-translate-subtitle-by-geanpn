const {
  addonBuilder,
  serveHTTP,
  publishToCentral,
} = require("stremio-addon-sdk");
const opensubtitles = require("./opensubtitles");
const connection = require("./connection");
const languages = require("./languages");
const { createOrUpdateMessageSub } = require("./subtitles");
const translationQueue = require("./queues/translationQueue");
const baseLanguages = require("./langs/base.lang.json");
const isoCodeMapping = require("./langs/iso_code_mapping.json");
const languageDisplayNames = require("./langs/language_display_names.json");
require("dotenv").config();

// Helper function to get language display name
function getLanguageDisplayName(isoCode) {
  return languageDisplayNames[isoCode] || isoCode;
}

// Helper function to convert ISO code to 3-letter format for better Stremio compatibility
function getStremioLanguageCode(isoCode) {
  // Reverse mapping: tìm mã 3 chữ cái từ mã 2 chữ cái
  for (const [threeLetterCode, twoLetterCode] of Object.entries(isoCodeMapping)) {
    if (twoLetterCode === isoCode) {
      return threeLetterCode;
    }
  }
  return isoCode;
}

// Tách riêng BASE_URL cho subtitle và server
function getBaseUrl() {
  const address = process.env.ADDRESS || 'localhost';
  const port = process.env.PORT || 3000;
  
  // Chỉ thêm port nếu không phải port mặc định
  const portSuffix = (port === 80 || port === 443 || port === '80' || port === '443') 
    ? '' 
    : `:${port}`;
  
  return `http://${address}${portSuffix}`;
}

// BASE_URL cho subtitle - có thể custom riêng
function getSubtitleBaseUrl() {
  // Nếu có SUBTITLE_BASE_URL riêng, dùng nó
  if (process.env.SUBTITLE_BASE_URL) {
    let url = process.env.SUBTITLE_BASE_URL;
    // Tự động thêm http:// nếu không có protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }
    return url;
  }
  
  // Nếu có BASE_URL chung, dùng nó
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  
  // Mặc định dùng BASE_URL tự động
  return getBaseUrl();
}

const BASE_URL = process.env.BASE_URL || getBaseUrl();
const SUBTITLE_BASE_URL = getSubtitleBaseUrl();

function generateSubtitleUrl(
  targetLanguage,
  imdbid,
  season,
  episode,
  provider
) {
  return `${SUBTITLE_BASE_URL}/subtitles/${provider}/${targetLanguage}/${imdbid}/season${season}/${imdbid}-translated-${episode}-1.srt`;
}

const builder = new addonBuilder({
  id: "org.autotranslate.geanpn",
  version: "1.0.2",
  name: "Auto Subtitle Translate by geanpn",
  logo: "./subtitles/logo.webp",
  configurable: true,
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  config: [
    {
      key: "provider",
      title: "Provider",
      type: "select",
      required: true,
      options: ["Google Translate", "ChatGPT API"],
    },
    {
      key: "apikey",
      title: "ChatGPT API Key",
      type: "text",
      required: false,
      dependencies: [
        {
          key: "provider",
          value: ["ChatGPT API"],
        },
      ],
    },
    {
      key: "base_url",
      title: "ChatGPT API Base URL",
      type: "text",
      required: false,
      default: "https://api.openai.com/v1",
      dependencies: [
        {
          key: "provider",
          value: ["ChatGPT API"],
        },
      ],
    },
    {
      key: "model_name",
      title: "ChatGPT API Model Name",
      type: "text",
      required: false,
      default: "gpt-4o-mini",
      dependencies: [
        {
          key: "provider",
          value: ["ChatGPT API"],
        },
      ],
    },
    {
      key: "translateto",
      title: "Translate to",
      type: "select",
      required: true,
      default: "English",
      options: baseLanguages,
    },
  ],
  description:
    "This addon takes subtitles from OpenSubtitlesV3 then translates into desired language using Google Translate, or ChatGPT (OpenAI Compatible Providers). For donations:in progress Bug report: geanpn@gmail.com",
  types: ["series", "movie"],
  catalogs: [],
  resources: ["subtitles"],
});

builder.defineSubtitlesHandler(async function (args) {
  console.log("Subtitle request received:", args);
  
  try {
    const { id, config, stream } = args;

    const targetLanguage = languages.getKeyFromValue(
      config.translateto,
      config.provider
    );

    if (!targetLanguage) {
      console.log("Unsupported language:", config.translateto);
      return Promise.resolve({ subtitles: [] });
    }

    // Lấy tên ngôn ngữ để hiển thị
    const displayLanguageName = getLanguageDisplayName(targetLanguage);
    
    // Lấy mã ngôn ngữ 3 chữ cái cho Stremio (tương thích tốt hơn)
    const stremioLanguageCode = getStremioLanguageCode(targetLanguage);

    console.log(`Language mapping: ${config.translateto} -> ${targetLanguage} -> ${stremioLanguageCode} (${displayLanguageName})`);

    // Extract imdbid from id
    let imdbid = null;
    if (id.startsWith("dcool-")) {
      imdbid = "tt5994346";
    } else if (id !== null && id.startsWith("tt")) {
      const parts = id.split(":");
      if (parts.length >= 1) {
        imdbid = parts[0];
      } else {
        console.log("Invalid ID format.");
      }
    }

    if (imdbid === null) {
      console.log("Invalid ID format.");
      return Promise.resolve({ subtitles: [] });
    }

    const { type, season = null, episode = null } = parseId(id);
    
    // 1. Check if already exists in database
    const existingSubtitle = await connection.getsubtitles(
      imdbid,
      season,
      episode,
      targetLanguage
    );

    if (existingSubtitle.length > 0) {
      const subtitleUrl = generateSubtitleUrl(
        targetLanguage,
        imdbid,
        season,
        episode,
        config.provider
      );
      console.log("Subtitle found in database:", subtitleUrl);
      return Promise.resolve({
        subtitles: [
          {
            id: stremioLanguageCode, // Dùng mã 3 chữ cái
            url: subtitleUrl,
            lang: displayLanguageName, // Tên ngôn ngữ hiển thị đẹp
          },
        ],
      });
    }

    // 2. If not found, search OpenSubtitles
    const subs = await opensubtitles.getsubtitles(
      type,
      imdbid,
      season,
      episode,
      targetLanguage
    );

    if (!subs || subs.length === 0) {
      await createOrUpdateMessageSub(
        "No subtitles found on OpenSubtitles",
        imdbid,
        season,
        episode,
        targetLanguage,
        config.provider
      );
      return Promise.resolve({
        subtitles: [
          {
            id: stremioLanguageCode,
            url: generateSubtitleUrl(
              targetLanguage,
              imdbid,
              season,
              episode,
              config.provider
            ),
            lang: displayLanguageName,
          },
        ],
      });
    }

    const foundSubtitle = subs[0];

    const mappedFoundSubtitleLang = isoCodeMapping[foundSubtitle.lang] || foundSubtitle.lang;

    if (mappedFoundSubtitleLang === targetLanguage) {
      console.log(
        "Desired language subtitle found on OpenSubtitles, returning it directly."
      );
      await connection.addsubtitle(
        imdbid,
        type,
        season,
        episode,
        foundSubtitle.url.replace(`${SUBTITLE_BASE_URL}/`, ""),
        targetLanguage
      );
      return Promise.resolve({
        subtitles: [
          {
            id: stremioLanguageCode,
            url: foundSubtitle.url,
            lang: displayLanguageName,
          },
        ],
      });
    }

    console.log(
      "Subtitles found on OpenSubtitles, but not in target language. Translating..."
    );

    await createOrUpdateMessageSub(
      "Translating subtitles. Please wait 1 minute and try again.",
      imdbid,
      season,
      episode,
      targetLanguage,
      config.provider
    );

    // 3. Process and translate subtitles
    translationQueue.push({
      subs: [foundSubtitle],
      imdbid: imdbid,
      season: season,
      episode: episode,
      oldisocode: targetLanguage,
      provider: config.provider,
      apikey: config.apikey ?? null,
      base_url: config.base_url ?? "https://api.openai.com/v1",
      model_name: config.model_name ?? "gpt-4o-mini",
    });

    const subtitleUrl = generateSubtitleUrl(
      targetLanguage,
      imdbid,
      season,
      episode,
      config.provider
    );
    console.log("Subtitles processed", subtitleUrl);

    await connection.addsubtitle(
      imdbid,
      type,
      season,
      episode,
      subtitleUrl.replace(`${SUBTITLE_BASE_URL}/`, ""),
      targetLanguage
    );

    return Promise.resolve({
      subtitles: [
        {
          id: stremioLanguageCode,
          url: subtitleUrl,
          lang: displayLanguageName,
        },
      ],
    });
  } catch (error) {
    console.error("Error processing subtitles:", error);
    return Promise.resolve({ subtitles: [] });
  }
});

function parseId(id) {
  if (id.startsWith("tt")) {
    const match = id.match(/tt(\d+):(\d+):(\d+)/);
    if (match) {
      const [, , season, episode] = match;
      return {
        type: "series",
        season: Number(season),
        episode: Number(episode),
      };
    } else {
      return { type: "movie", season: 1, episode: 1 };
    }
  } else if (id.startsWith("dcool-")) {
    const match = id.match(/dcool-(.+)::(.+)-episode-(\d+)/);
    if (match) {
      const [, , title, episode] = match;
      return {
        type: "series",
        title: title,
        episode: Number(episode),
        season: 1,
      };
    }
  }
  return { type: "unknown", season: 0, episode: 0 };
}

if (process.env.PUBLISH_IN_STREMIO_STORE == "TRUE") {
  // Dùng SUBTITLE_BASE_URL nếu có, không thì dùng BASE_URL
  const manifestUrl = process.env.SUBTITLE_BASE_URL 
    ? `${SUBTITLE_BASE_URL}/manifest.json`
    : `${BASE_URL}/manifest.json`;
  
  console.log("Publishing to Stremio Central:", manifestUrl);
  publishToCentral(manifestUrl).catch((error) => {
    console.error("Failed to publish to Stremio Central:", error);
    console.error("Make sure your manifest URL is publicly accessible");
  });
}

const port = process.env.PORT || 3000;
const address = process.env.ADDRESS || "0.0.0.0";

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  if (reason && reason.stack) {
    console.error('Stack:', reason.stack);
  }
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack:', error.stack);
});

serveHTTP(builder.getInterface(), {
  cacheMaxAge: 10,
  port: port,
  address: address,
  static: "/subtitles",
})
  .then(() => {
    console.log(`Server started: http://${address}:${port}`);
    console.log(
      "Manifest available:",
      `http://${address}:${port}/manifest.json`
    );
    console.log("BASE_URL:", BASE_URL);
    console.log("SUBTITLE_BASE_URL:", SUBTITLE_BASE_URL);
  })
  .catch((error) => {
    console.error("Server startup error:", error);
  });
