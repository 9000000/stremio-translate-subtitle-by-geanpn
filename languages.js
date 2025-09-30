const googleLanguages = require("./langs/translateGoogleFree.lang.json");
const chatgptLanguages = require("./langs/translateChatGpt.lang.json");

function getValueFromKey(key, provider) {
  let langMap;
  switch (provider) {
    case "Google Translate":
      langMap = googleLanguages;
      break;
    case "ChatGPT API":
      langMap = chatgptLanguages;
      break;
    default:
      throw new Error("Provider not found");
  }
  return langMap[key];
}

function getKeyFromValue(value, provider) {
  let langMap;
  switch (provider) {
    case "Google Translate":
      langMap = googleLanguages;
      break;
    case "ChatGPT API":
      langMap = chatgptLanguages;
      break;
    default:
      throw new Error("Provider not found");
  }

  for (let key in langMap) {
    if (langMap[key] === value) {
      return key;
    }
  }
  return null;
}

function getAllValues(provider) {
  let langMap;
  switch (provider) {
    case "Google Translate":
      langMap = googleLanguages;
      break;
    case "ChatGPT API":
      langMap = chatgptLanguages;
      break;
    default:
      throw new Error("Provider not found");
  }
  return Object.values(langMap);
}

module.exports = {
  getAllValues,
  getKeyFromValue,
  getValueFromKey,
};
