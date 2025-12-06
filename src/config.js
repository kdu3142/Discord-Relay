import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from config.env file
const configEnvPath = join(__dirname, '..', 'config.env');
const templatePath = join(__dirname, '..', 'config.env.example');
console.log(`[Config] Loading config from: ${configEnvPath}`);

// Auto-create config.env from template if it doesn't exist
if (!fs.existsSync(configEnvPath)) {
  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, configEnvPath);
    console.log(`[Config] Created config.env from template`);
  } else {
    console.log(`[Config] ⚠️ config.env file NOT FOUND at ${configEnvPath}`);
    console.log(`[Config] ⚠️ Template file also NOT FOUND at ${templatePath}`);
  }
}

// Check if file exists
if (fs.existsSync(configEnvPath)) {
  console.log(`[Config] config.env file exists`);
  const stats = fs.statSync(configEnvPath);
  console.log(`[Config] config.env size: ${stats.size} bytes`);
} else {
  console.log(`[Config] ⚠️ config.env file NOT FOUND at ${configEnvPath}`);
}

const result = dotenv.config({ path: configEnvPath });
if (result.error) {
  console.log(`[Config] ⚠️ Error loading config.env: ${result.error.message}`);
} else {
  console.log(`[Config] config.env loaded successfully`);
}

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
/**
 * Clean a token string by removing whitespace and invisible characters
 */
function cleanToken(token) {
  if (!token) return null;
  // Remove invisible characters (zero-width spaces, BOM, control chars, etc.)
  const cleaned = token
    .replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200D\uFEFF]/g, '')
    .trim();
  return cleaned || null;
}

const config = {
  // Required
  discord: {
    // Clean token to avoid whitespace and invisible character issues
    token: cleanToken(process.env.DISCORD_TOKEN),
    clientId: cleanToken(process.env.DISCORD_CLIENT_ID),
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
    // Allow DMs - any DM to the bot triggers the webhook (no prefix needed)
    allowDMs: process.env.ALLOW_DMS === 'true' || process.env.ALLOW_DMS === '1',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

// Validate on module load
validateConfig();

/**
 * Reload configuration from config.env file
 * This allows dynamic reloading without restarting the process
 */
export function reloadConfig() {
  // Clear cached env vars that were loaded from config.env
  const keysToReload = [
    'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'N8N_WEBHOOK_URL', 'N8N_WEBHOOKS',
    'RELAY_SHARED_SECRET', 'BOT_PREFIX', 'ALLOWED_GUILD_IDS', 'ALLOW_DMS', 'LOG_LEVEL'
  ];
  
  keysToReload.forEach(key => {
    delete process.env[key];
  });
  
  // Reload from file
  const result = dotenv.config({ path: configEnvPath, override: true });
  if (result.error) {
    console.log(`[Config] ⚠️ Error reloading config.env: ${result.error.message}`);
    return null;
  }
  
  console.log('[Config] Reloaded config.env successfully');
  
  // Return new config values
  return {
    discord: {
      token: cleanToken(process.env.DISCORD_TOKEN),
      clientId: cleanToken(process.env.DISCORD_CLIENT_ID),
    },
    n8n: {
      webhookUrl: (() => {
        const rawUrl = process.env.N8N_WEBHOOK_URL;
        if (!rawUrl) return null;
        const trimmedUrl = rawUrl.trim();
        if (trimmedUrl === '' || trimmedUrl === 'your_n8n_webhook_url_here') {
          return null;
        }
        return trimmedUrl;
      })(),
      webhooks: parseWebhooks(process.env.N8N_WEBHOOKS),
    },
    relay: {
      sharedSecret: process.env.RELAY_SHARED_SECRET || null,
    },
    bot: {
      prefix: process.env.BOT_PREFIX || '!bot',
      allowedGuildIds: process.env.ALLOWED_GUILD_IDS
        ? process.env.ALLOWED_GUILD_IDS.split(',').map(id => id.trim()).filter(Boolean)
        : null,
      allowDMs: process.env.ALLOW_DMS === 'true' || process.env.ALLOW_DMS === '1',
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
    },
  };
}

/**
 * Export config file path for external use
 */
export const configPath = configEnvPath;

/**
 * Read config file content directly
 */
export async function readConfigFile() {
  try {
    const content = await fs.promises.readFile(configEnvPath, 'utf-8');
    return content;
  } catch (error) {
    console.log(`[Config] Error reading config file: ${error.message}`);
    return '';
  }
}

/**
 * Parse env file content into object
 */
export function parseEnv(content) {
  const result = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) {
      let value = match[2];
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
  }
  
  return result;
}

// Log config loading (without sensitive data)
if (process.env.DISCORD_TOKEN) {
  const rawToken = process.env.DISCORD_TOKEN;
  const cleanedToken = cleanToken(rawToken);
  const tokenMasked = cleanedToken && cleanedToken.length > 14 
    ? `${cleanedToken.substring(0, 10)}...${cleanedToken.substring(cleanedToken.length - 4)}`
    : '***';
  
  const hasInvisibleChars = /[\x00-\x1F\x7F-\x9F\u200B-\u200D\uFEFF]/.test(rawToken);
  const hasWhitespace = rawToken !== rawToken.trim();
  
  console.log(`[Config] Discord token loaded: ${tokenMasked}`);
  console.log(`[Config] Token length - raw: ${rawToken.length}, cleaned: ${cleanedToken?.length || 0}`);
  console.log(`[Config] Token has whitespace: ${hasWhitespace}`);
  console.log(`[Config] Token has invisible chars: ${hasInvisibleChars}`);
  console.log(`[Config] Token parts (split by .): ${cleanedToken?.split('.').length || 0}`);
  
  if (hasInvisibleChars) {
    console.log('[Config] ⚠️ WARNING: Token contains invisible characters that were removed!');
  }
  if (hasWhitespace) {
    console.log('[Config] ⚠️ WARNING: Token had whitespace that was trimmed!');
  }
} else {
  console.log('[Config] Discord token not found in environment');
}

export default config;
export { cleanToken };
