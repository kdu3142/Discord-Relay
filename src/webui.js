import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { testWebhook, sendToN8n } from './relay.js';
import { formatMessageEvent } from './payload.js';
import { isBotCalled } from './filters.js';
import { 
  configPath as configPathFromConfig, 
  reloadConfig, 
  readConfigFile, 
  parseEnv,
  cleanToken 
} from './config.js';

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

// Get the config.env file path (use from config module for consistency)
const configPath = configPathFromConfig || join(__dirname, '..', 'config.env');

// Export these functions for use in other modules
export { readConfigFile, parseEnv };

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

// Note: readConfigFile and parseEnv are imported from config.js and re-exported above

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
    
    // Check if bot is connected - use multiple indicators since isReady() can be unreliable
    const isConnected = discordClient.isReady() || 
                        (discordClient.user && discordClient.ws.status === 0);
    
    if (!isConnected) {
      return res.status(400).json({ 
        success: false, 
        error: 'Discord bot is not connected. Please check your DISCORD_TOKEN and ensure the bot is running.',
        debug: {
          isReady: discordClient.isReady(),
          hasUser: !!discordClient.user,
          wsStatus: discordClient.ws.status,
        }
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
    // Read token from config for analysis
    const configContent = await readConfigFile();
    const config = parseEnv(configContent);
    const token = config.DISCORD_TOKEN || '';
    const tokenTrimmed = token.trim();
    
    // Analyze token
    const tokenAnalysis = {
      exists: !!token,
      isEmpty: tokenTrimmed === '',
      isPlaceholder: tokenTrimmed === 'your_discord_bot_token_here',
      length: tokenTrimmed.length,
      hasWhitespace: token !== tokenTrimmed,
      parts: tokenTrimmed.split('.').length,
      startsWithAlphanumeric: /^[A-Za-z0-9]/.test(tokenTrimmed),
      firstPart: tokenTrimmed.split('.')[0]?.substring(0, 10) || '',
      masked: tokenTrimmed.length > 14 
        ? `${tokenTrimmed.substring(0, 10)}...${tokenTrimmed.substring(tokenTrimmed.length - 4)}`
        : '***',
    };
    
    if (!discordClient) {
      return res.json({
        success: true,
        status: {
          connected: false,
          error: 'Bot not started yet',
          tokenAnalysis,
        },
      });
    }
    
    const { GatewayIntentBits } = await import('discord.js');
    
    // Debug: log client state
    console.log('[Status Check] isReady:', discordClient.isReady());
    console.log('[Status Check] ws.status:', discordClient.ws.status);
    console.log('[Status Check] user:', discordClient.user?.tag || 'null');
    console.log('[Status Check] guilds:', discordClient.guilds?.cache.size || 0);
    
    const status = {
      connected: discordClient.isReady(),
      botTag: discordClient.user?.tag || null,
      botId: discordClient.user?.id || null,
      guilds: discordClient.guilds?.cache.size || 0,
      intents: discordClient.options.intents?.toArray() || [],
      hasGuilds: discordClient.options.intents?.has(GatewayIntentBits.Guilds) || false,
      hasGuildMessages: discordClient.options.intents?.has(GatewayIntentBits.GuildMessages) || false,
      hasMessageContent: discordClient.options.intents?.has(GatewayIntentBits.MessageContent) || false,
      wsStatus: discordClient.ws.status,
      wsPing: discordClient.ws.ping,
      tokenAnalysis,
    };

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Diagnose token and connection issues
app.get('/api/diagnose', async (req, res) => {
  try {
    const configContent = await readConfigFile();
    const config = parseEnv(configContent);
    const token = config.DISCORD_TOKEN || '';
    const tokenTrimmed = token.trim();
    
    // Check for invisible/special characters
    const hasInvisibleChars = /[\x00-\x1F\x7F-\x9F\u200B-\u200D\uFEFF]/.test(token);
    const firstBytes = token.substring(0, 20).split('').map(c => c.charCodeAt(0));
    const lastBytes = token.substring(Math.max(0, token.length - 10)).split('').map(c => c.charCodeAt(0));
    
    // Clean token (remove any invisible characters)
    const tokenCleaned = token.replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200D\uFEFF]/g, '').trim();
    
    const diagnosis = {
      timestamp: new Date().toISOString(),
      configFile: {
        exists: !!configContent,
        size: configContent.length,
        path: configPath,
      },
      token: {
        exists: !!token,
        isEmpty: tokenTrimmed === '',
        isPlaceholder: tokenTrimmed === 'your_discord_bot_token_here',
        length: tokenTrimmed.length,
        lengthRaw: token.length,
        lengthCleaned: tokenCleaned.length,
        hasWhitespace: token !== tokenTrimmed,
        hasInvisibleChars: hasInvisibleChars,
        whitespaceDetails: {
          leadingSpaces: token.length - token.trimStart().length,
          trailingSpaces: token.length - token.trimEnd().length,
        },
        format: {
          parts: tokenTrimmed.split('.').length,
          startsWithAlphanumeric: /^[A-Za-z0-9]/.test(tokenTrimmed),
          containsDots: tokenTrimmed.includes('.'),
          firstPartLength: tokenTrimmed.split('.')[0]?.length || 0,
          secondPartLength: tokenTrimmed.split('.')[1]?.length || 0,
          thirdPartLength: tokenTrimmed.split('.')[2]?.length || 0,
        },
        masked: tokenTrimmed.length > 14 
          ? `${tokenTrimmed.substring(0, 10)}...${tokenTrimmed.substring(tokenTrimmed.length - 4)}`
          : '***',
        firstBytes: firstBytes,
        lastBytes: lastBytes,
      },
      discordClient: {
        exists: !!discordClient,
        isReady: discordClient?.isReady() || false,
        user: discordClient?.user ? {
          id: discordClient.user.id,
          tag: discordClient.user.tag,
          username: discordClient.user.username,
        } : null,
        ws: {
          status: discordClient?.ws?.status,
          ping: discordClient?.ws?.ping,
        },
      },
    };
    
    // Try to validate token with Discord API directly
    if (tokenTrimmed && tokenTrimmed !== 'your_discord_bot_token_here') {
      try {
        const axios = (await import('axios')).default;
        const response = await axios.get('https://discord.com/api/v10/users/@me', {
          headers: {
            'Authorization': `Bot ${tokenTrimmed}`,
          },
          timeout: 10000,
        });
        
        diagnosis.apiTest = {
          success: true,
          status: response.status,
          user: {
            id: response.data.id,
            username: response.data.username,
            discriminator: response.data.discriminator,
            bot: response.data.bot,
          },
        };
        
        addLogEntry('info', `✅ Token válido! Bot: ${response.data.username}#${response.data.discriminator}`, {
          botId: response.data.id,
          botUsername: response.data.username,
        });
      } catch (apiError) {
        diagnosis.apiTest = {
          success: false,
          status: apiError.response?.status,
          statusText: apiError.response?.statusText,
          error: apiError.message,
          code: apiError.code,
          response: apiError.response?.data,
        };
        
        if (apiError.response?.status === 401) {
          addLogEntry('error', '❌ Token INVÁLIDO - Discord rejeitou a autenticação (401)', {
            error: apiError.response?.data,
          });
        } else {
          addLogEntry('error', `❌ Erro ao testar token: ${apiError.message}`, {
            status: apiError.response?.status,
            code: apiError.code,
          });
        }
      }
    }
    
    res.json({ success: true, diagnosis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Force reconnect to Discord
app.post('/api/reconnect', async (req, res) => {
  try {
    if (!discordClient) {
      return res.status(400).json({ 
        success: false, 
        error: 'Discord client not available' 
      });
    }
    
    addLogEntry('info', '🔄 Forçando reconexão ao Discord...');
    
    // Reload config from file to get latest token
    console.log('[Reconnect] Reloading config from file...');
    addLogEntry('info', '📄 Recarregando configuração do arquivo...');
    
    const newConfig = reloadConfig();
    
    // Get token from reloaded config or read directly from file
    let cleanedToken;
    if (newConfig && newConfig.discord.token) {
      cleanedToken = newConfig.discord.token;
      console.log('[Reconnect] Using token from reloaded config');
    } else {
      // Fallback: read directly from file
      const configContent = await readConfigFile();
      const config = parseEnv(configContent);
      const token = config.DISCORD_TOKEN?.trim();
      
      if (!token || token === 'your_discord_bot_token_here') {
        return res.status(400).json({
          success: false,
          error: 'Token not configured',
        });
      }
      
      cleanedToken = cleanToken(token);
      console.log('[Reconnect] Using token from direct file read');
    }
    
    if (!cleanedToken) {
      return res.status(400).json({
        success: false,
        error: 'Token not configured or invalid',
      });
    }
    
    const tokenMasked = cleanedToken.length > 14 
      ? `${cleanedToken.substring(0, 10)}...${cleanedToken.substring(cleanedToken.length - 4)}`
      : '***';
    
    addLogEntry('info', `🔑 Token carregado: ${tokenMasked} (${cleanedToken.length} chars)`);
    
    // Log before reconnect
    console.log('[Reconnect] Destroying current connection...');
    addLogEntry('info', '🔄 Destruindo conexão atual...');
    
    // Destroy current connection
    discordClient.destroy();
    
    console.log('[Reconnect] Client destroyed, waiting 2 seconds...');
    addLogEntry('info', '⏳ Aguardando 2 segundos...');
    
    // Wait a bit before reconnecting
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('[Reconnect] Attempting login...');
    addLogEntry('info', '🔄 Tentando reconectar...');
    
    try {
      await discordClient.login(cleanedToken);
      
      console.log('[Reconnect] Login successful!');
      addLogEntry('info', '✅ Reconexão bem-sucedida!');
      
      // Wait a bit for the ready event
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      res.json({
        success: true,
        message: 'Reconnected successfully',
        status: {
          isReady: discordClient.isReady(),
          wsStatus: discordClient.ws.status,
          user: discordClient.user ? {
            id: discordClient.user.id,
            tag: discordClient.user.tag,
          } : null,
        },
      });
    } catch (loginError) {
      console.log('[Reconnect] Login failed:', loginError.message);
      addLogEntry('error', `❌ Falha ao reconectar: ${loginError.message}`, {
        error: loginError.message,
        code: loginError.code,
      });
      
      res.json({
        success: false,
        error: loginError.message,
        code: loginError.code,
      });
    }
  } catch (error) {
    addLogEntry('error', `Erro ao reconectar: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Reload configuration from file (without reconnecting)
app.post('/api/reload-config', async (req, res) => {
  try {
    addLogEntry('info', '📄 Recarregando configuração do arquivo...');
    
    const newConfig = reloadConfig();
    
    if (newConfig) {
      addLogEntry('info', '✅ Configuração recarregada com sucesso!');
      
      // Return summary of what was loaded (without sensitive data)
      res.json({
        success: true,
        message: 'Configuration reloaded',
        config: {
          hasToken: !!newConfig.discord.token,
          tokenLength: newConfig.discord.token?.length || 0,
          hasClientId: !!newConfig.discord.clientId,
          hasDefaultWebhook: !!newConfig.n8n.webhookUrl,
          webhooksCount: Object.keys(newConfig.n8n.webhooks || {}).length,
          hasSharedSecret: !!newConfig.relay.sharedSecret,
          botPrefix: newConfig.bot.prefix,
          allowedGuilds: newConfig.bot.allowedGuildIds?.length || 'all',
          logLevel: newConfig.logging.level,
        },
      });
    } else {
      res.json({
        success: false,
        error: 'Failed to reload configuration',
      });
    }
  } catch (error) {
    addLogEntry('error', `Erro ao recarregar config: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get server info (uptime, memory, etc.)
app.get('/api/server-info', (req, res) => {
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  
  res.json({
    success: true,
    info: {
      uptime: {
        seconds: Math.floor(uptime),
        formatted: formatUptime(uptime),
      },
      memory: {
        rss: formatBytes(memory.rss),
        heapUsed: formatBytes(memory.heapUsed),
        heapTotal: formatBytes(memory.heapTotal),
      },
      node: process.version,
      platform: process.platform,
    },
  });
});

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  
  return parts.join(' ');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

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
