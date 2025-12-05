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

  const required = ['DISCORD_TOKEN'];
  const missing = required.filter(key => !process.env[key] || 
    process.env[key] === 'your_discord_bot_token_here'
  );

  // Check if at least one webhook is configured
  // Trim whitespace before checking to prevent whitespace-only URLs from passing
  const defaultWebhookUrl = process.env.N8N_WEBHOOK_URL ? process.env.N8N_WEBHOOK_URL.trim() : '';
  const hasDefaultWebhook = defaultWebhookUrl && 
    defaultWebhookUrl !== 'your_n8n_webhook_url_here' &&
    defaultWebhookUrl !== '';
  const hasMultipleWebhooks = process.env.N8N_WEBHOOKS && 
    process.env.N8N_WEBHOOKS.trim() !== '';

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Please check your config.env file and fill in the required values.\n' +
      'Or enable the web UI by setting START_WEBUI=true'
    );
  }

  if (!hasDefaultWebhook && !hasMultipleWebhooks) {
    throw new Error(
      'At least one n8n webhook URL must be configured (N8N_WEBHOOK_URL or N8N_WEBHOOKS).\n' +
      'Please check your config.env file.'
    );
  }

  // Validate webhook URLs (trim before validation to ensure consistency)
  const trimmedDefaultWebhook = process.env.N8N_WEBHOOK_URL ? process.env.N8N_WEBHOOK_URL.trim() : '';
  if (trimmedDefaultWebhook && 
      trimmedDefaultWebhook !== 'your_n8n_webhook_url_here' &&
      trimmedDefaultWebhook !== '') {
    try {
      new URL(trimmedDefaultWebhook);
    } catch (error) {
      throw new Error(
        `N8N_WEBHOOK_URL is not a valid URL: ${trimmedDefaultWebhook}`
      );
    }
  }

  // Validate multiple webhooks JSON
  // Trim URLs before validation to ensure consistency with parseWebhooks()
  if (process.env.N8N_WEBHOOKS && process.env.N8N_WEBHOOKS.trim() !== '') {
    try {
      const webhooks = JSON.parse(process.env.N8N_WEBHOOKS);
      for (const [name, url] of Object.entries(webhooks)) {
        if (typeof url !== 'string') {
          throw new Error(`Webhook "${name}" has invalid URL type`);
        }
        const trimmedUrl = url.trim();
        if (trimmedUrl === '') {
          throw new Error(`Webhook "${name}" has empty URL`);
        }
        // Validate trimmed URL to match what will actually be stored
        try {
          new URL(trimmedUrl);
        } catch (e) {
          throw new Error(`Webhook "${name}" URL is not valid: ${trimmedUrl}`);
        }
      }
    } catch (error) {
      throw new Error(`N8N_WEBHOOKS JSON is invalid: ${error.message}`);
    }
  }
}

/**
 * Parse multiple webhooks from JSON string
 * Filters out placeholder and empty values
 */
function parseWebhooks(webhooksJson) {
  if (!webhooksJson || webhooksJson.trim() === '') {
    return {};
  }
  try {
    const webhooks = JSON.parse(webhooksJson);
    // Filter out placeholder values and empty strings
    // Store trimmed URLs to ensure consistency between validation and usage
    const filtered = {};
    for (const [name, url] of Object.entries(webhooks)) {
      if (url && 
          typeof url === 'string') {
        const trimmedUrl = url.trim();
        if (trimmedUrl !== '' && 
            trimmedUrl !== 'your_n8n_webhook_url_here') {
          filtered[name] = trimmedUrl; // Store trimmed URL
        }
      }
    }
    return filtered;
  } catch (error) {
    // logger not available here, just return empty
    return {};
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
    // Default webhook (for backward compatibility)
    // Filter out placeholder value and trim whitespace to prevent sending to invalid URL
    webhookUrl: (() => {
      const rawUrl = process.env.N8N_WEBHOOK_URL;
      if (!rawUrl) return null;
      const trimmedUrl = rawUrl.trim();
      if (trimmedUrl === '' || trimmedUrl === 'your_n8n_webhook_url_here') {
        return null;
      }
      return trimmedUrl; // Store trimmed URL for consistency
    })(),
    // Multiple webhooks: JSON format {"workflow1": "url1", "workflow2": "url2"}
    webhooks: parseWebhooks(process.env.N8N_WEBHOOKS),
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
