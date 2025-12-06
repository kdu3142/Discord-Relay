import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import config, { readConfigFile, parseEnv } from './config.js';
import logger from './logger.js';
import { isBotCalled, isGuildAllowed } from './filters.js';
import { formatMessageEvent } from './payload.js';
import { sendToN8n } from './relay.js';
import { startWebUI as startConfigWebUI, addLogEntry, setDiscordClient } from './webui.js';

/**
 * Check if DMs are allowed (reads from config file for latest value)
 */
async function areDMsAllowed() {
  try {
    const configContent = await readConfigFile();
    const envConfig = parseEnv(configContent);
    return envConfig.ALLOW_DMS === 'true' || envConfig.ALLOW_DMS === '1';
  } catch (error) {
    // Fallback to cached config
    return config.bot.allowDMs;
  }
}

// Log configuration on startup (send to both console and WebUI)
console.log('='.repeat(60));
console.log('Discord Relay Bot - Starting...');
console.log('='.repeat(60));

const startupInfo = {
  hasToken: !!config.discord.token,
  tokenLength: config.discord.token ? config.discord.token.length : 0,
  tokenIsPlaceholder: config.discord.token === 'your_discord_bot_token_here',
  hasClientId: !!config.discord.clientId,
};

console.log(`[Startup] Token exists: ${startupInfo.hasToken}`);
console.log(`[Startup] Token length: ${startupInfo.tokenLength}`);
console.log(`[Startup] Token is placeholder: ${startupInfo.tokenIsPlaceholder}`);

if (config.discord.token && config.discord.token.length > 14) {
  const masked = `${config.discord.token.substring(0, 10)}...${config.discord.token.substring(config.discord.token.length - 4)}`;
  console.log(`[Startup] Token (masked): ${masked}`);
}

logger.info('Discord Relay Bot starting...', startupInfo);
addLogEntry('info', 'Bot iniciando...', startupInfo);

// Create Discord client with required intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,        // Required for DMs
    GatewayIntentBits.DirectMessageTyping,   // Optional: typing indicator in DMs
  ],
  // Partials are required to receive DM events (DM channels may not be cached)
  partials: [
    Partials.Channel,  // Required for DM channels
    Partials.Message,  // Required for uncached messages
  ],
});

// Export client for testing purposes
export { client };

// Client ready event
client.once(Events.ClientReady, (readyClient) => {
  const logData = {
    botTag: readyClient.user.tag,
    botId: readyClient.user.id,
    guilds: readyClient.guilds.cache.size,
    username: readyClient.user.username,
    discriminator: readyClient.user.discriminator,
  };
  logger.info('Discord bot is ready!', logData);
  addLogEntry('info', `✅ Bot conectado: ${readyClient.user.tag} (${readyClient.guilds.cache.size} servidores)`, logData);
  
  // Log intents for debugging
  const intents = client.options.intents;
  const intentStatus = {
    intents: intents.toArray(),
    hasGuilds: intents.has(GatewayIntentBits.Guilds),
    hasGuildMessages: intents.has(GatewayIntentBits.GuildMessages),
    hasMessageContent: intents.has(GatewayIntentBits.MessageContent),
    hasDirectMessages: intents.has(GatewayIntentBits.DirectMessages),
    intentBits: intents.bitfield?.toString(),
  };
  logger.info('Bot intents configured', intentStatus);
  addLogEntry('info', `Intents configurados: ${intents.toArray().join(', ')}`, intentStatus);
  
  // Log DM configuration
  const dmStatus = config.bot.allowDMs ? '✅ Habilitadas' : '❌ Desabilitadas';
  logger.info('DM configuration', { allowDMs: config.bot.allowDMs });
  addLogEntry('info', `📩 Mensagens Diretas (DMs): ${dmStatus}`, { allowDMs: config.bot.allowDMs });
  
  // Log guilds for debugging
  const guildList = readyClient.guilds.cache.map(g => ({ id: g.id, name: g.name }));
  logger.info('Bot is in these servers', { guilds: guildList });
  if (guildList.length > 0) {
    addLogEntry('info', `Bot está em ${guildList.length} servidor(es)`, { guilds: guildList });
  } else {
    addLogEntry('warn', '⚠️ Bot não está em nenhum servidor. Adicione o bot a um servidor via OAuth2 URL Generator', {});
  }
  
  // Log shard info
  logger.info('Shard information', {
    shardId: readyClient.shard?.ids?.[0] ?? 0,
    totalShards: readyClient.shard?.count ?? 1,
  });
});

// Message create event handler
client.on(Events.MessageCreate, async (message) => {
  try {
    const isDM = !message.guild;
    const channelType = isDM ? 'DM' : 'Guild';
    
    // Log all messages for debugging (can be filtered by log level)
    logger.debug('Message received', {
      messageId: message.id,
      authorId: message.author.id,
      authorBot: message.author.bot,
      authorUsername: message.author.username,
      channelId: message.channel.id,
      channelName: message.channel.name || 'DM',
      channelType,
      isDM,
      guildId: message.guild?.id || null,
      guildName: message.guild?.name || null,
      content: message.content.substring(0, 100), // First 100 chars for debugging
      hasMentions: message.mentions.users.size > 0,
    });

    // For DMs, log at info level so they're visible
    if (isDM) {
      console.log(`[Message] DM from ${message.author.username}: ${message.content.substring(0, 50)}...`);
    }

    // Ignore bot messages
    if (message.author.bot) {
      return;
    }

    let rule, cleanContent;

    // Handle DMs separately - no prefix/mention needed
    if (!message.guild) {
      // Check if DMs are allowed (read from config file for latest value)
      const dmsAllowed = await areDMsAllowed();
      
      if (!dmsAllowed) {
        logger.debug('Message is DM, but DMs are disabled in config', {
          messageId: message.id,
          authorId: message.author.id,
        });
        return;
      }

      // DM - treat entire message as the command
      rule = 'dm';
      cleanContent = message.content.trim();

      logger.info('DM received - processing message', {
        messageId: message.id,
        authorId: message.author.id,
        authorUsername: message.author.username,
        content: cleanContent.substring(0, 100),
      });
      addLogEntry('info', `📩 DM recebida de ${message.author.username}: "${cleanContent.substring(0, 50)}"`, {
        messageId: message.id,
        authorId: message.author.id,
        content: cleanContent.substring(0, 100),
      });
    } else {
      // Server message - check guild and prefix/mention

      // Check if guild is allowed (if restriction is configured)
      if (!isGuildAllowed(message.guild)) {
        logger.debug('Message from disallowed guild, skipping', {
          guildId: message.guild.id,
          guildName: message.guild.name,
          messageId: message.id,
        });
        return;
      }

      // Check if bot was called (prefix or mention)
      const callResult = isBotCalled(message, client);

      if (!callResult.called) {
        logger.debug('Bot was not called in message, ignoring', {
          messageId: message.id,
          content: message.content.substring(0, 50),
          prefix: config.bot.prefix,
          botMentioned: message.mentions.has(client.user),
        });
        return; // Bot was not called, ignore message
      }

      rule = callResult.rule;
      cleanContent = callResult.cleanContent;
    }

    logger.info('Bot was called - processing message', {
      messageId: message.id,
      channelId: message.channel.id,
      channelName: message.channel.name || 'dm',
      guildId: message.guild?.id || null,
      guildName: message.guild?.name || 'DM',
      authorId: message.author.id,
      authorUsername: message.author.username,
      rule,
      cleanContent,
      isDM: !message.guild,
    });

    if (rule !== 'dm') {
      addLogEntry('info', `💬 Bot acionado via ${rule}: "${cleanContent.substring(0, 50)}"`, {
        messageId: message.id,
        rule,
      });
    }

    // Format the payload
    const payload = formatMessageEvent(message, 'message_create', rule);

    // Send to all configured n8n webhooks
    const results = await sendToN8n(payload);

    // Check if any webhooks are configured
    if (results.length === 0) {
      const errorMsg = 'No webhooks configured - message not relayed';
      logger.warn(errorMsg, {
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guild.id,
      });
      addLogEntry('warn', '⚠️ Nenhum webhook configurado - mensagem não foi enviada', {
        messageId: message.id,
      });
      return; // Exit early if no webhooks
    }

    // Log results for each webhook
    for (const result of results) {
      if (result.success) {
        const logData = {
          messageId: message.id,
          webhook: result.webhook,
          status: result.status,
        };
        logger.info(`Successfully relayed to ${result.webhook} webhook`, logData);
        addLogEntry('info', `✅ Enviado para ${result.webhook} (${result.status})`, logData);
      } else {
        const logData = {
          messageId: message.id,
          webhook: result.webhook,
          error: result.error,
          status: result.status,
        };
        logger.error(`Failed to relay to ${result.webhook} webhook`, logData);
        addLogEntry('error', `❌ Falha ao enviar para ${result.webhook}: ${result.error}`, logData);
      }
    }
  } catch (error) {
    logger.error('Error processing message', {
      error: error.message,
      stack: error.stack,
      messageId: message.id,
    });
  }
});

// Error handling - Detailed logging
client.on(Events.Error, (error) => {
  logger.error('Discord client error', {
    error: error.message,
    code: error.code,
    stack: error.stack,
    name: error.name,
  });
  addLogEntry('error', `Erro do cliente Discord: ${error.message}`, {
    error: error.message,
    code: error.code,
  });
});

client.on(Events.Warn, (warning) => {
  logger.warn('Discord client warning', { warning });
  addLogEntry('warn', `Aviso do cliente Discord: ${warning}`, { warning });
});

// Debug event - shows all debug messages from discord.js
client.on(Events.Debug, (info) => {
  logger.debug('Discord client debug', { info });
  // Only log critical debug messages to avoid spam
  if (info.includes('token') || info.includes('auth') || info.includes('connect') || info.includes('disconnect')) {
    addLogEntry('debug', `Discord debug: ${info}`, { info });
  }
});

// Disconnect event
client.on(Events.ShardDisconnect, (event, shardId) => {
  logger.warn('Discord shard disconnected', {
    shardId,
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
  });
  addLogEntry('warn', `Shard ${shardId} desconectado: ${event.reason} (code: ${event.code})`, {
    shardId,
    code: event.code,
    reason: event.reason,
  });
});

// Reconnecting event
client.on(Events.ShardReconnecting, (shardId) => {
  logger.info('Discord shard reconnecting', { shardId });
  addLogEntry('info', `Shard ${shardId} reconectando...`, { shardId });
});

// Resume event (reconnected after disconnect)
client.on(Events.ShardResume, (shardId, replayedEvents) => {
  logger.info('Discord shard resumed', { shardId, replayedEvents });
  addLogEntry('info', `Shard ${shardId} reconectado (${replayedEvents} eventos recuperados)`, {
    shardId,
    replayedEvents,
  });
});

// Invalid session event
client.on(Events.InvalidSession, (resumable) => {
  logger.warn('Discord invalid session', { resumable });
  addLogEntry('warn', `Sessão Discord inválida (resumable: ${resumable})`, { resumable });
});

// Handle process signals for graceful shutdown
const shutdown = async (signal) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  try {
    client.destroy();
    logger.info('Discord client destroyed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', {
    error: error.message,
    stack: error.stack,
  });
});

// Check if web UI should be started
const enableWebUI = process.env.START_WEBUI === 'true' || process.env.START_WEBUI === '1';

if (enableWebUI) {
  logger.info('Starting configuration Web UI...');
  // Pass client reference to web UI for testing
  setDiscordClient(client);
  startConfigWebUI();
}

// Start the bot (only if token is configured)
// Token is already trimmed in config.js, but double-check
const token = config.discord.token;
const tokenTrimmed = token ? token.trim() : '';

// Detailed token validation and logging
if (token && token !== 'your_discord_bot_token_here' && tokenTrimmed !== '') {
  // Mask token for logging (show first 10 chars and last 4 chars)
  const tokenMasked = tokenTrimmed.length > 14 
    ? `${tokenTrimmed.substring(0, 10)}...${tokenTrimmed.substring(tokenTrimmed.length - 4)}`
    : '***';
  
  logger.info('Starting Discord relay bot...', {
    tokenLength: tokenTrimmed.length,
    tokenPrefix: tokenTrimmed.substring(0, 10),
    tokenSuffix: tokenTrimmed.substring(tokenTrimmed.length - 4),
    hasWhitespace: token !== tokenTrimmed,
    intents: client.options.intents.toArray(),
  });
  addLogEntry('info', `Tentando conectar ao Discord... Token: ${tokenMasked}`, {
    tokenLength: tokenTrimmed.length,
    intents: client.options.intents.toArray(),
  });
  
  // Check for common token issues
  if (token !== tokenTrimmed) {
    logger.warn('Token has leading/trailing whitespace - this may cause authentication issues', {
      originalLength: token.length,
      trimmedLength: tokenTrimmed.length,
    });
    addLogEntry('warn', '⚠️ Token tem espaços em branco - isso pode causar problemas de autenticação', {
      originalLength: token.length,
      trimmedLength: tokenTrimmed.length,
    });
  }
  
  // Validate token format
  if (tokenTrimmed.length < 50) {
    logger.warn('Token seems too short - Discord bot tokens are typically 59+ characters', {
      tokenLength: tokenTrimmed.length,
    });
    addLogEntry('warn', '⚠️ Token parece muito curto - tokens do Discord geralmente têm 59+ caracteres', {
      tokenLength: tokenTrimmed.length,
    });
  }
  
  // Check token format (Discord bot tokens typically have dots)
  const tokenParts = tokenTrimmed.split('.');
  if (tokenParts.length < 3) {
    logger.warn('Token format may be incorrect - Discord bot tokens typically have 2 dots (3 parts)', {
      tokenLength: tokenTrimmed.length,
      parts: tokenParts.length,
      firstPart: tokenParts[0]?.substring(0, 10),
    });
    addLogEntry('warn', '⚠️ Formato do token pode estar incorreto - tokens do Discord geralmente têm 2 pontos', {
      parts: tokenParts.length,
    });
  }
  
  // Check if token looks like a Discord token (starts with alphanumeric)
  if (!/^[A-Za-z0-9]/.test(tokenTrimmed)) {
    logger.warn('Token does not start with alphanumeric character - may be invalid', {
      firstChar: tokenTrimmed[0],
    });
    addLogEntry('warn', `⚠️ Token não começa com caractere alfanumérico - pode ser inválido (primeiro char: ${tokenTrimmed[0]})`, {
      firstChar: tokenTrimmed[0],
    });
  }
  
  // Attempt login with detailed error handling
  console.log('[Login] ========================================');
  console.log('[Login] About to call client.login()');
  console.log(`[Login] Token length: ${tokenTrimmed.length}`);
  console.log(`[Login] Token (masked): ${tokenTrimmed.substring(0, 10)}...${tokenTrimmed.substring(tokenTrimmed.length - 4)}`);
  console.log(`[Login] Client ready state before login: ${client.isReady()}`);
  console.log(`[Login] WS status before login: ${client.ws.status}`);
  console.log('[Login] ========================================');
  
  logger.info('Attempting Discord login...');
  addLogEntry('info', '🔄 Chamando client.login()...');
  
  // Use async/await for better error handling
  (async () => {
    try {
      console.log('[Login] Calling client.login() NOW...');
      addLogEntry('info', '🔄 Executando login...');
      
      const loginResult = await client.login(tokenTrimmed);
      
      console.log('[Login] client.login() returned:', loginResult ? 'token' : 'undefined');
      console.log(`[Login] Client ready after login: ${client.isReady()}`);
      console.log(`[Login] WS status after login: ${client.ws.status}`);
      
      logger.info('Discord login successful');
      addLogEntry('info', '✅ Login no Discord bem-sucedido!');
    } catch (error) {
      console.log('[Login] ERROR in client.login():', error.message);
      console.log('[Login] Error code:', error.code);
      console.log('[Login] Error name:', error.name);
      
      // Detailed error logging
      const errorDetails = {
        error: error.message,
        code: error.code,
        name: error.name,
        stack: error.stack,
        tokenLength: tokenTrimmed.length,
        tokenPrefix: tokenTrimmed.substring(0, 10),
      };
      
      logger.error('Failed to login to Discord', errorDetails);
      addLogEntry('error', `❌ Falha ao fazer login no Discord: ${error.message}`, {
        error: error.message,
        code: error.code,
      });
      
      // Provide specific error messages based on error type
      if (error.message.includes('Invalid token') || error.message.includes('401')) {
        logger.error('AUTHENTICATION ERROR: Invalid Discord bot token', {
          suggestion: 'Please verify your DISCORD_TOKEN in config.env',
          tokenFormat: 'Discord bot tokens typically start with letters/numbers and contain dots',
          tokenLength: tokenTrimmed.length,
        });
        addLogEntry('error', '❌ Token inválido! Verifique o DISCORD_TOKEN no config.env', {
          suggestion: 'O token deve ser do tipo "Bot Token" do Discord Developer Portal',
        });
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        logger.error('NETWORK ERROR: Cannot reach Discord servers', {
          suggestion: 'Check your internet connection and firewall settings',
        });
        addLogEntry('error', '❌ Erro de rede: Não foi possível conectar aos servidores do Discord', {
          suggestion: 'Verifique sua conexão com a internet',
        });
      } else if (error.message.includes('rate limit') || error.message.includes('429')) {
        logger.error('RATE LIMIT: Too many login attempts', {
          suggestion: 'Wait a few minutes before trying again',
        });
        addLogEntry('error', '❌ Rate limit: Muitas tentativas de login. Aguarde alguns minutos', {});
      } else if (error.message.includes('Disallowed') || error.message.includes('intents')) {
        logger.error('INTENTS ERROR: Disallowed intents', {
          suggestion: 'Enable MESSAGE CONTENT INTENT in Discord Developer Portal',
          intents: client.options.intents.toArray(),
        });
        addLogEntry('error', '❌ Erro de Intents: Habilite MESSAGE CONTENT INTENT no Developer Portal', {
          intents: client.options.intents.toArray(),
        });
      } else {
        logger.error('UNKNOWN ERROR: Unexpected error during Discord login', errorDetails);
        addLogEntry('error', `❌ Erro desconhecido: ${error.message}`, {
          code: error.code,
        });
      }
      
      // Don't exit if web UI is enabled - allow user to fix config
      if (!enableWebUI) {
        process.exit(1);
      }
    }
  })();
} else {
  if (enableWebUI) {
    logger.warn('Discord bot token not configured. Please configure via web UI at http://localhost:' + (process.env.WEBUI_PORT || 3001));
    addLogEntry('warn', '⚠️ Token do Discord não configurado. Configure via Web UI.', {});
  } else {
    logger.error('Discord bot token not configured. Please set DISCORD_TOKEN in config.env file or enable web UI.');
    addLogEntry('error', '❌ Token do Discord não configurado. Configure DISCORD_TOKEN no config.env', {});
    process.exit(1);
  }
}
