/**
 * Formats a Discord message event into a normalized JSON payload for n8n
 * @param {import('discord.js').Message} message - The Discord message object
 * @param {string} eventType - The event type (e.g., "message_create")
 * @param {string} matchedRule - The rule that triggered the bot (e.g., "prefix:!bot" or "mention")
 * @returns {Object} - Normalized payload object
 */
export function formatMessageEvent(message, eventType, matchedRule) {
  const timestamp = new Date().toISOString();
  const messageTimestamp = message.createdAt.toISOString();

  // Format attachments
  const attachments = message.attachments.map(attachment => ({
    id: attachment.id,
    filename: attachment.name,
    url: attachment.url,
    content_type: attachment.contentType || null,
    size: attachment.size,
    height: attachment.height,
    width: attachment.width,
  }));

  // Format guild information
  const guild = message.guild
    ? {
        id: message.guild.id,
        name: message.guild.name,
      }
    : null;

  // Format channel information
  const channel = {
    id: message.channel.id,
    name: message.channel.isDMBased() ? 'dm' : message.channel.name,
    type: message.channel.type,
  };

  // Format author information
  const author = {
    id: message.author.id,
    username: message.author.username,
    display_name: message.author.displayName || message.author.username,
    discriminator: message.author.discriminator !== '0' ? message.author.discriminator : null,
    bot: message.author.bot,
    avatar: message.author.displayAvatarURL() || null,
  };

  // Get clean content (already processed by filters)
  const cleanContent = message.content.trim();

  // Build the payload
  const payload = {
    event_type: eventType,
    relay: {
      version: 1,
      source: 'discord',
      bot_called: true,
      matched_rule: matchedRule,
    },
    timestamp,
    guild,
    channel,
    message: {
      id: message.id,
      content: message.content,
      clean_content: cleanContent,
      created_at: messageTimestamp,
      attachments,
      embeds: message.embeds.length > 0 ? message.embeds.map(embed => ({
        title: embed.title,
        description: embed.description,
        url: embed.url,
        color: embed.color,
        timestamp: embed.timestamp,
        fields: embed.fields,
      })) : [],
    },
    author,
  };

  return payload;
}
