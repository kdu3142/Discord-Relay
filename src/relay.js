import axios from 'axios';
import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';

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
 * Sends payload to n8n webhook with retry logic
 * @param {Object} payload - The normalized payload to send
 * @returns {Promise<{ success: boolean, status?: number, error?: string }>}
 */
export async function sendToN8n(payload) {
  const webhookUrl = config.n8n.webhookUrl;
  const sharedSecret = config.relay.sharedSecret;
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
      logger.debug('Sending payload to n8n', {
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
        logger.info('Successfully sent payload to n8n', {
          status: response.status,
          attempt: attempt + 1,
        });
        return { success: true, status: response.status };
      } else {
        // 4xx errors are not retried (client errors)
        logger.warn('n8n webhook returned non-success status', {
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
        logger.error('Failed to send payload to n8n', {
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
      logger.warn('Retrying n8n webhook request', {
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        delayMs: delay,
        error: error.message,
      });

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript/static analysis might want it
  return {
    success: false,
    error: 'Max retries exceeded',
  };
}
