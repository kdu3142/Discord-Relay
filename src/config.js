import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from config.env file
// This is the main configuration file where you store all your tokens, URLs, and keys
dotenv.config({ path: join(__dirname, '..', 'config.env') });

/**
 * Validates that required environment variables are present
 * Only validates if web UI is not enabled (to allow configuration via web UI)
 */
function validateConfig() {
  // Skip validation if web UI is enabled (allows configuration via web UI)
  const webUIEnabled = process.env.START_WEBUI === 'true' || process.env.START_WEBUI === '1';
  if (webUIEnabled) {
    return; // Allow web UI to configure settings
  }

  const required = ['DISCORD_TOKEN', 'N8N_WEBHOOK_URL'];
  const missing = required.filter(key => !process.env[key] || 
    process.env[key] === 'your_discord_bot_token_here' ||
    process.env[key] === 'your_n8n_webhook_url_here'
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Please check your config.env file and fill in the required values.\n' +
      'Or enable the web UI by setting START_WEBUI=true'
    );
  }

  // Validate N8N_WEBHOOK_URL is a valid URL (if provided)
  if (process.env.N8N_WEBHOOK_URL && 
      process.env.N8N_WEBHOOK_URL !== 'your_n8n_webhook_url_here') {
    try {
      new URL(process.env.N8N_WEBHOOK_URL);
    } catch (error) {
      throw new Error(
        `N8N_WEBHOOK_URL is not a valid URL: ${process.env.N8N_WEBHOOK_URL}`
      );
    }
  }
}

/**
 * Configuration object with all environment variables
 */
const config = {
  // Required
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID || null,
  },
  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL,
  },

  // Optional
  relay: {
    sharedSecret: process.env.RELAY_SHARED_SECRET || null,
  },
  bot: {
    prefix: process.env.BOT_PREFIX || '!bot',
    allowedGuildIds: process.env.ALLOWED_GUILD_IDS
      ? process.env.ALLOWED_GUILD_IDS.split(',').map(id => id.trim()).filter(Boolean)
      : null,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

// Validate on module load
validateConfig();

export default config;
