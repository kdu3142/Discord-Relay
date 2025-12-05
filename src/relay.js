import axios from 'axios';
import crypto from 'crypto';
import config, { reloadConfig, readConfigFile, parseEnv } from './config.js';
import logger from './logger.js';

/**
 * Get current webhook configuration
 * This reads from file to ensure we have the latest saved config
 */
async function getCurrentWebhooks() {
  try {
    // Try to read fresh config from file
    const configContent = await readConfigFile();
    const envConfig = parseEnv(configContent);
    
    // Parse default webhook
    let defaultWebhook = null;
    const rawUrl = envConfig.N8N_WEBHOOK_URL;
    if (rawUrl) {
      const trimmedUrl = rawUrl.trim();
      if (trimmedUrl !== '' && trimmedUrl !== 'your_n8n_webhook_url_here') {
        defaultWebhook = trimmedUrl;
      }
    }
    
    // Parse multiple webhooks
    const webhooks = {};
    if (envConfig.N8N_WEBHOOKS) {
      try {
        const parsed = JSON.parse(envConfig.N8N_WEBHOOKS);
        for (const [name, url] of Object.entries(parsed)) {
          if (url && typeof url === 'string') {
            const trimmedUrl = url.trim();
            if (trimmedUrl !== '' && trimmedUrl !== 'your_n8n_webhook_url_here') {
              webhooks[name] = trimmedUrl;
            }
          }
        }
      } catch (e) {
        logger.warn('Failed to parse N8N_WEBHOOKS JSON', { error: e.message });
      }
    }
    
    // Parse shared secret
    const sharedSecret = envConfig.RELAY_SHARED_SECRET || null;
    
    return { defaultWebhook, webhooks, sharedSecret };
  } catch (error) {
    logger.warn('Failed to read fresh config, using cached config', { error: error.message });
    // Fallback to cached config
    return {
      defaultWebhook: config.n8n.webhookUrl,
      webhooks: config.n8n.webhooks || {},
      sharedSecret: config.relay.sharedSecret,
    };
  }
}

/**
 * Generates HMAC signature for the payload
 * @param {Object} payload - The payload object to sign
 * @param {string} secret - The shared secret
 * @returns {string} - Hex-encoded HMAC signature
 */
function generateSignature(payload, secret) {
  const payloadString = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadString);
  return hmac.digest('hex');
}

/**
 * Sends payload to a specific n8n webhook URL with retry logic
 * @param {string} webhookUrl - The webhook URL to send to
 * @param {Object} payload - The normalized payload to send
 * @param {string} webhookName - Optional name for logging
 * @param {string} sharedSecret - Optional shared secret for HMAC
 * @returns {Promise<{ success: boolean, status?: number, error?: string }>}
 */
async function sendToWebhook(webhookUrl, payload, webhookName = 'n8n', sharedSecret = null) {
  const timestamp = new Date().toISOString();

  // Prepare headers
  const headers = {
    'Content-Type': 'application/json',
    'X-Relay-Timestamp': timestamp,
  };

  // Add HMAC signature if shared secret is configured
  if (sharedSecret) {
    const signature = generateSignature(payload, sharedSecret);
    headers['X-Relay-Signature'] = signature;
  }

  // Retry configuration
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`Sending payload to ${webhookName}`, {
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        webhookUrl: webhookUrl.replace(/\/[^\/]+$/, '/***'), // Mask webhook path
      });

      const response = await axios.post(webhookUrl, payload, {
        headers,
        timeout: 10000, // 10 second timeout
        validateStatus: (status) => status < 500, // Don't throw on 4xx errors
      });

      if (response.status >= 200 && response.status < 300) {
        logger.info(`Successfully sent payload to ${webhookName}`, {
          status: response.status,
          attempt: attempt + 1,
        });
        return { success: true, status: response.status };
      } else {
        // 4xx errors are not retried (client errors)
        logger.warn(`${webhookName} webhook returned non-success status`, {
          status: response.status,
          statusText: response.statusText,
          data: response.data,
        });
        return {
          success: false,
          status: response.status,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isNetworkError =
        error.code === 'ECONNREFUSED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.response?.status >= 500;

      if (isLastAttempt || !isNetworkError) {
        logger.error(`Failed to send payload to ${webhookName}`, {
          error: error.message,
          code: error.code,
          status: error.response?.status,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
        });
        return {
          success: false,
          error: error.message || 'Unknown error',
          status: error.response?.status,
        };
      }

      // Calculate exponential backoff delay
      const delay = baseDelay * Math.pow(2, attempt);
      logger.warn(`Retrying ${webhookName} webhook request`, {
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        delayMs: delay,
        error: error.message,
      });

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    success: false,
    error: 'Max retries exceeded',
  };
}

/**
 * Sends payload to all configured n8n webhooks
 * @param {Object} payload - The normalized payload to send
 * @returns {Promise<Array<{ webhook: string, success: boolean, status?: number, error?: string }>>}
 */
export async function sendToN8n(payload) {
  const results = [];
  
  // Get current webhook configuration (reads from file for latest values)
  const { defaultWebhook, webhooks, sharedSecret } = await getCurrentWebhooks();
  
  logger.debug('Current webhook configuration', {
    hasDefaultWebhook: !!defaultWebhook,
    webhooksCount: Object.keys(webhooks).length,
    hasSharedSecret: !!sharedSecret,
  });
  
  // Send to default webhook if configured
  if (defaultWebhook) {
    const result = await sendToWebhook(defaultWebhook, payload, 'default', sharedSecret);
    results.push({
      webhook: 'default',
      url: defaultWebhook,
      ...result,
    });
  }

  // Send to all additional webhooks
  for (const [name, url] of Object.entries(webhooks)) {
    const result = await sendToWebhook(url, payload, name, sharedSecret);
    results.push({
      webhook: name,
      url: url,
      ...result,
    });
  }

  return results;
}

/**
 * Test a webhook URL by sending a test payload
 * @param {string} webhookUrl - The webhook URL to test
 * @param {string} sharedSecret - Optional shared secret for HMAC
 * @returns {Promise<{ success: boolean, status?: number, error?: string, responseTime?: number }>}
 */
export async function testWebhook(webhookUrl, sharedSecret = null) {
  const testPayload = {
    event_type: 'test',
    relay: {
      version: 1,
      source: 'discord',
      bot_called: false,
      matched_rule: 'test',
    },
    timestamp: new Date().toISOString(),
    message: 'This is a test payload from Discord Relay Bot',
  };

  const timestamp = new Date().toISOString();
  const headers = {
    'Content-Type': 'application/json',
    'X-Relay-Timestamp': timestamp,
  };

  if (sharedSecret) {
    const signature = generateSignature(testPayload, sharedSecret);
    headers['X-Relay-Signature'] = signature;
  }

  const startTime = Date.now();

  try {
    const response = await axios.post(webhookUrl, testPayload, {
      headers,
      timeout: 10000,
      validateStatus: () => true, // Accept all status codes for testing
    });

    const responseTime = Date.now() - startTime;

    return {
      success: response.status >= 200 && response.status < 300,
      status: response.status,
      responseTime,
      data: response.data,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      success: false,
      error: error.message || 'Unknown error',
      code: error.code,
      status: error.response?.status,
      responseTime,
    };
  }
}
