import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { testWebhook, sendToN8n } from './relay.js';
import { formatMessageEvent } from './payload.js';
import { isBotCalled } from './filters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static HTML
app.use(express.static(join(__dirname, '../webui')));

// Event emitter for real-time logs
const logEmitter = new EventEmitter();

// Store recent logs (last 100 entries)
const recentLogs = [];
const MAX_LOGS = 100;

// Get the config.env file path (this is the main configuration file)
const configPath = join(__dirname, '..', 'config.env');

/**
 * Add log entry to recent logs
 */
export function addLogEntry(level, message, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
  };
  
  recentLogs.push(logEntry);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.shift();
  }
  
  // Emit to connected clients
  logEmitter.emit('log', logEntry);
}

/**
 * Read current config.env file or return empty config
 */
async function readConfigFile() {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return content;
  } catch (error) {
    // config.env doesn't exist, return empty
    return '';
  }
}

/**
 * Parse config.env file into object (ignores comments)
 */
function parseEnv(content) {
  const config = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      // Remove quotes if present
      config[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  
  return config;
}

/**
 * Convert config object back to config.env format
 * Preserves all comments, documentation, and structure
 */
function stringifyConfig(config, template) {
  const lines = template.split('\n');
  const result = [];
  
  for (const line of lines) {
    if (line.trim().startsWith('#')) {
      // Keep all comments and documentation
      result.push(line);
    } else {
      const match = line.match(/^([^=]+)=/);
      if (match) {
        const key = match[1].trim();
        if (config[key] !== undefined && config[key] !== '') {
          // Update the value while preserving the line structure
          result.push(`${key}=${config[key]}`);
        } else {
          // Keep original line if value not provided
          result.push(line);
        }
      } else {
        // Keep empty lines and other content
        result.push(line);
      }
    }
  }
  
  return result.join('\n');
}

// API: Get current configuration (reads from config.env)
app.get('/api/config', async (req, res) => {
  try {
    const configContent = await readConfigFile();
    const config = parseEnv(configContent);
    
    // Parse N8N_WEBHOOKS JSON if present
    if (config.N8N_WEBHOOKS) {
      try {
        config.N8N_WEBHOOKS_PARSED = JSON.parse(config.N8N_WEBHOOKS);
      } catch (e) {
        config.N8N_WEBHOOKS_PARSED = {};
      }
    } else {
      config.N8N_WEBHOOKS_PARSED = {};
    }
    
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Save configuration (writes to config.env)
app.post('/api/config', async (req, res) => {
  try {
    const newConfig = req.body;
    
    // Handle multiple webhooks
    if (newConfig.N8N_WEBHOOKS_PARSED) {
      try {
        newConfig.N8N_WEBHOOKS = JSON.stringify(newConfig.N8N_WEBHOOKS_PARSED);
        delete newConfig.N8N_WEBHOOKS_PARSED;
      } catch (e) {
        return res.status(400).json({ success: false, error: 'Invalid webhooks JSON format' });
      }
    }
    
    // Read current config.env file (preserves all comments and documentation)
    let template;
    try {
      template = await fs.readFile(configPath, 'utf-8');
    } catch (error) {
      // If config.env doesn't exist, we can't save (shouldn't happen)
      throw new Error('config.env file not found. Please create it first.');
    }
    
    // Merge with existing config
    const existingContent = await readConfigFile();
    const existingConfig = parseEnv(existingContent);
    const mergedConfig = { ...existingConfig, ...newConfig };
    
    // Generate config.env content (preserves all comments)
    const configContent = stringifyConfig(mergedConfig, template);
    
    // Write to config.env file
    await fs.writeFile(configPath, configContent, 'utf-8');
    
    addLogEntry('info', 'Configuration saved successfully');
    
    res.json({ success: true, message: 'Configuration saved to config.env successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Validate configuration
app.post('/api/validate', async (req, res) => {
  try {
    const config = req.body;
    const errors = [];
    const warnings = [];
    
    // Required fields
    if (!config.DISCORD_TOKEN || config.DISCORD_TOKEN === 'your_discord_bot_token_here') {
      errors.push('DISCORD_TOKEN is required');
    }
    
    // Check webhooks (trim URLs for consistent validation)
    const defaultWebhookUrl = config.N8N_WEBHOOK_URL ? config.N8N_WEBHOOK_URL.trim() : '';
    const hasDefaultWebhook = defaultWebhookUrl && 
      defaultWebhookUrl !== 'your_n8n_webhook_url_here' &&
      defaultWebhookUrl !== '';
    
    let hasMultipleWebhooks = false;
    if (config.N8N_WEBHOOKS_PARSED) {
      const webhooks = config.N8N_WEBHOOKS_PARSED;
      hasMultipleWebhooks = Object.keys(webhooks).length > 0 && 
        Object.values(webhooks).some(url => url && typeof url === 'string' && url.trim() !== '');
    }
    
    if (!hasDefaultWebhook && !hasMultipleWebhooks) {
      errors.push('At least one n8n webhook URL is required');
    }
    
    // Validate URLs (use trimmed URLs for validation)
    if (defaultWebhookUrl && defaultWebhookUrl !== 'your_n8n_webhook_url_here') {
      try {
        new URL(defaultWebhookUrl);
      } catch (e) {
        errors.push('N8N_WEBHOOK_URL must be a valid URL');
      }
    }
    
    if (config.N8N_WEBHOOKS_PARSED) {
      for (const [name, url] of Object.entries(config.N8N_WEBHOOKS_PARSED)) {
        if (url && typeof url === 'string') {
          const trimmedUrl = url.trim();
          if (trimmedUrl !== '') {
            try {
              new URL(trimmedUrl);
            } catch (e) {
              errors.push(`Webhook "${name}" URL is not valid`);
            }
          }
        }
      }
    }
    
    // Warnings
    if (!config.RELAY_SHARED_SECRET) {
      warnings.push('RELAY_SHARED_SECRET is recommended for security');
    }
    
    res.json({
      success: errors.length === 0,
      errors,
      warnings,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Test webhook
app.post('/api/test-webhook', async (req, res) => {
  try {
    const { webhookUrl, sharedSecret } = req.body;
    
    // Trim URL immediately for consistent validation
    const trimmedUrl = webhookUrl ? webhookUrl.trim() : '';
    
    if (!trimmedUrl || trimmedUrl === '') {
      return res.status(400).json({ success: false, error: 'Webhook URL is required' });
    }
    
    // Validate trimmed URL
    try {
      new URL(trimmedUrl);
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid webhook URL format' });
    }
    
    addLogEntry('info', `Testing webhook: ${trimmedUrl.replace(/\/[^\/]+$/, '/***')}`);
    
    // Use trimmed URL for testing
    const result = await testWebhook(trimmedUrl, sharedSecret || null);
    
    if (result.success) {
      addLogEntry('info', `Webhook test successful (${result.status})`, { responseTime: result.responseTime });
    } else {
      addLogEntry('error', `Webhook test failed: ${result.error}`, result);
    }
    
    res.json({ success: true, result });
  } catch (error) {
    addLogEntry('error', `Webhook test error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get recent logs
app.get('/api/logs', (req, res) => {
  res.json({ success: true, logs: recentLogs });
});

// SSE endpoint for real-time logs
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial logs
  res.write(`data: ${JSON.stringify({ logs: recentLogs })}\n\n`);
  
  // Send new logs as they come
  const logHandler = (logEntry) => {
    res.write(`data: ${JSON.stringify({ log: logEntry })}\n\n`);
  };
  
  logEmitter.on('log', logHandler);
  
  req.on('close', () => {
    logEmitter.off('log', logHandler);
  });
});

// Store reference to Discord client (set by index.js)
let discordClient = null;

/**
 * Set Discord client reference for testing
 */
export function setDiscordClient(client) {
  discordClient = client;
}

// API: Test Discord integration (simulate a message)
app.post('/api/test-discord', async (req, res) => {
  try {
    if (!discordClient) {
      return res.status(400).json({ 
        success: false, 
        error: 'Discord client not available. Bot may not be started yet.' 
      });
    }
    
    if (!discordClient.isReady()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Discord bot is not connected. Please check your DISCORD_TOKEN and ensure the bot is running.' 
      });
    }

    const { testMessage } = req.body;
    // Get prefix from config (read from env)
    const configContent = await readConfigFile();
    const config = parseEnv(configContent);
    const prefix = config.BOT_PREFIX || '!bot';
    const testMsg = testMessage || `${prefix} teste`;
    
    // Create a mock message object that mimics Discord's message structure
    const mockMessage = {
      id: `test_${Date.now()}`,
      content: testMsg,
      author: {
        id: '123456789012345678',
        username: 'TestUser',
        displayName: 'Test User',
        bot: false,
        discriminator: '0',
        displayAvatarURL: () => null,
      },
      channel: {
        id: '234567890123456789',
        name: 'test-channel',
        type: 0,
        isDMBased: () => false,
      },
      guild: {
        id: '345678901234567890',
        name: 'Test Server',
      },
      mentions: {
        has: (user) => {
          // Check if message mentions the bot
          const botMention = `<@${discordClient.user.id}>`;
          const botMentionAlt = `<@!${discordClient.user.id}>`;
          return testMsg.includes(botMention) || testMsg.includes(botMentionAlt);
        },
        users: {
          size: 0,
        },
      },
      attachments: [],
      embeds: [],
      createdAt: new Date(),
    };

    addLogEntry('info', `🧪 Testando integração Discord: "${mockMessage.content}"`);

    // Check if bot would be called
    const { called, rule, cleanContent } = isBotCalled(mockMessage, discordClient);
    
    if (!called) {
      const botTag = discordClient.user?.tag || 'Bot';
      addLogEntry('warn', `⚠️ Bot não foi acionado. Verifique: prefixo="${prefix}" ou menção ao bot`);
      return res.json({
        success: false,
        error: 'Bot was not called',
        details: {
          message: mockMessage.content,
          prefix: prefix,
          botMentioned: mockMessage.mentions.has(discordClient.user),
          suggestion: `Try: "${prefix} teste" or mention the bot (@${botTag})`,
        },
      });
    }

    addLogEntry('info', `✅ Bot acionado via ${rule}: "${cleanContent}"`);

    // Format the payload
    const payload = formatMessageEvent(mockMessage, 'message_create', rule);

    // Send to all configured n8n webhooks
    const results = await sendToN8n(payload);

    if (results.length === 0) {
      addLogEntry('warn', '⚠️ Nenhum webhook configurado para receber o teste');
      return res.json({
        success: false,
        error: 'No webhooks configured',
        details: {
          messageProcessed: true,
          botCalled: true,
          rule,
          webhooksConfigured: 0,
        },
      });
    }

    // Log results
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    if (successCount > 0) {
      addLogEntry('info', `✅ Teste enviado com sucesso para ${successCount} webhook(s)`);
    }
    if (failCount > 0) {
      addLogEntry('error', `❌ Falha ao enviar para ${failCount} webhook(s)`);
    }

    res.json({
      success: successCount > 0,
      message: successCount > 0 
        ? `Test message sent successfully to ${successCount} webhook(s)`
        : 'Test message failed to send to all webhooks',
      details: {
        messageProcessed: true,
        botCalled: true,
        rule,
        cleanContent,
        webhooksTotal: results.length,
        webhooksSuccess: successCount,
        webhooksFailed: failCount,
        results: results.map(r => ({
          webhook: r.webhook,
          success: r.success,
          status: r.status,
          error: r.error,
        })),
      },
    });
  } catch (error) {
    addLogEntry('error', `Erro no teste Discord: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get bot status
app.get('/api/bot-status', async (req, res) => {
  try {
    if (!discordClient) {
      return res.json({
        success: true,
        status: {
          connected: false,
          error: 'Bot not started yet',
        },
      });
    }
    
    const { GatewayIntentBits } = await import('discord.js');
    
    const status = {
      connected: discordClient.isReady(),
      botTag: discordClient.user?.tag || null,
      botId: discordClient.user?.id || null,
      guilds: discordClient.guilds?.cache.size || 0,
      intents: discordClient.options.intents?.toArray() || [],
      hasGuilds: discordClient.options.intents?.has(GatewayIntentBits.Guilds) || false,
      hasGuildMessages: discordClient.options.intents?.has(GatewayIntentBits.GuildMessages) || false,
      hasMessageContent: discordClient.options.intents?.has(GatewayIntentBits.MessageContent) || false,
    };

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.WEBUI_PORT || 3001;

export function startWebUI() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔════════════════════════════════════════════════════════════╗`);
    console.log(`║  Discord Relay Bot - Configuration Web UI                 ║`);
    console.log(`╚════════════════════════════════════════════════════════════╝`);
    console.log(`\n🌐 Web UI is running at: http://localhost:${PORT}`);
    console.log(`📝 Configure your bot settings in the web interface`);
    console.log(`📄 All changes are saved to: config.env\n`);
  });
}
