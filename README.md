# Discord Relay Bot

A Dockerized Discord Gateway bot that relays Discord events (when the bot is called via mention or prefix) to n8n webhooks via HTTP POST with HMAC security.

## Architecture

This bot acts as a relay service that:
- Connects to Discord via Gateway using `discord.js`
- Listens for messages where the bot is called (prefix `!bot` or mention)
- Formats normalized JSON payloads
- POSTs to n8n webhook with HMAC signature for security
- Runs as a Docker container alongside Supabase and n8n

All Discord-specific complexity (Gateway, intents, authentication) lives in this relay bot. n8n just receives clean HTTP POST requests.

## Prerequisites

- Node.js 20+ (for local development)
- Docker and Docker Compose (for containerized deployment)
- Discord Bot Token (from Discord Developer Portal)
- n8n instance with a webhook endpoint configured

## Discord Bot Setup

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to the "Bot" tab
4. Click "Add Bot" and confirm
5. Copy the **Bot Token** (you'll need this for `DISCORD_TOKEN`)

### 2. Enable Required Intents

In the Bot settings, enable these **Privileged Gateway Intents**:
- ✅ **Message Content Intent** (required to read message content)
- ✅ **Server Members Intent** (if needed for future features)

Also ensure these standard intents are enabled:
- ✅ **GUILDS**
- ✅ **GUILD_MESSAGES**

### 3. Install Bot to Your Server

1. Go to **OAuth2 → URL Generator**
2. Select scopes:
   - `bot`
   - `applications.commands` (optional, for future slash commands)
3. Select bot permissions:
   - Read Messages/View Channels
   - Send Messages (if you want the bot to respond)
   - Read Message History
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

## Quick Start / First Time Setup

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd discord-relay
   ```

2. **Create your configuration file:**
   The bot will automatically create `config.env` from `config.env.example` on first run, or you can manually copy it:
   ```bash
   cp config.env.example config.env
   ```

3. **Edit `config.env`** with your actual values (Discord token, n8n webhook URL, etc.)

4. **Start the bot** (see Docker Deployment section below)

> **Note:** `config.env` is in `.gitignore` and will not be committed to git. This ensures your secrets stay private and your configuration persists across `git pull` updates. The `config.env.example` file serves as a template with all available options documented.

## Configuration

### Option 1: Web UI (Recommended)

The bot includes a web-based configuration interface that makes setup easy:

1. **Start the bot with Web UI enabled** (default):
   ```bash
   docker run -d \
     --name discord-relay \
     -p 3001:3001 \
     -v $(pwd)/config.env:/app/config.env:rw \
     discord-relay
   ```

2. **Open your browser** and navigate to:
   ```
   http://localhost:3001
   ```

3. **Fill in the configuration form**:
   - Discord Bot Token
   - n8n Webhook URL
   - Shared Secret (optional but recommended)
   - Other settings as needed

4. **Click "Save Configuration"** - the settings will be saved to `config.env`

5. **Restart the bot** to apply the new configuration:
   ```bash
   docker restart discord-relay
   ```

### Option 2: Manual Configuration File

**Edit `config.env` directly** - this is your main configuration file!

If `config.env` doesn't exist, the bot will automatically create it from `config.env.example` on first run. You can also manually copy the template:
```bash
cp config.env.example config.env
```

The `config.env` file is where you store all your actual values:
- Your Discord bot token
- Your n8n webhook URL  
- Your shared secret
- All other settings

The file contains detailed comments explaining:
- What each setting does
- Where to find each value (with links)
- How to generate secrets
- Examples for each field

**Just open `config.env` in any text editor and fill in your values!** All the documentation is right there in the file, so you know exactly what to put where.

**Required:**
- `DISCORD_TOKEN` - Your bot token from Discord Developer Portal
- `N8N_WEBHOOK_URL` - Full URL to your n8n webhook endpoint

**Optional:**
- `RELAY_SHARED_SECRET` - Secret for HMAC signing (generate with: `openssl rand -hex 32`)
- `ALLOWED_GUILD_IDS` - Comma-separated guild IDs to restrict processing
- `BOT_PREFIX` - Command prefix (default: `!bot`)
- `LOG_LEVEL` - Logging verbosity (default: `info`)
- `START_WEBUI` - Enable web UI for configuration (default: `true`)
- `WEBUI_PORT` - Port for web UI (default: `3001`)

> **Note:** See `config.env` for detailed documentation of all configuration options with examples and instructions on where to find each value.

### Generate Shared Secret

For HMAC security between relay and n8n:

```bash
openssl rand -hex 32
```

Use this value for `RELAY_SHARED_SECRET` in both the bot's `config.env` and your n8n workflow.

## Local Development

### Install Dependencies

```bash
npm install
```

### Run Locally

```bash
npm start
```

Or with auto-reload:

```bash
npm run dev
```

## Docker Deployment

### Build Image

```bash
docker build -t discord-relay .
```

### Run Container

```bash
docker run -d \
  --name discord-relay \
  --restart unless-stopped \
  -p 3001:3001 \
  -v $(pwd)/config.env:/app/config.env:rw \
  discord-relay
```

### Using Docker Compose

```bash
docker-compose up -d
```

The `docker-compose.yml` file is configured to:
- Build the image automatically
- Restart the container unless stopped
- Load environment variables from `config.env`
- Mount `config.env` as a volume so the web UI can save configuration
- Expose web UI on port 3001 (configurable via `WEBUI_PORT`)
- Run alongside other services (n8n, Supabase)

**Important:** 
- If `config.env` doesn't exist, the bot will automatically create it from `config.env.example` on first run
- You can also manually copy the template: `cp config.env.example config.env`
- The `config.env` file will be mounted as a volume so the web UI can save your configuration
- Your `config.env` is ignored by git, so your secrets stay private and persist across `git pull` updates

## n8n Workflow Setup

### 1. Create Webhook Node

1. Add a **Webhook** node as the trigger
2. Set method to `POST`
3. Set path to something like `/discord/bot/<random-id>`
4. Copy the full webhook URL to `N8N_WEBHOOK_URL` in your `config.env`

### 2. Add Security Verification (Optional)

If you're using `RELAY_SHARED_SECRET`, add a **Code** node after the Webhook:

```javascript
const crypto = require('crypto');
const secret = $env.RELAY_SHARED_SECRET; // Set this in n8n environment
const receivedSignature = $headers['x-relay-signature'];
const timestamp = $headers['x-relay-timestamp'];
const body = JSON.stringify($json);

const hmac = crypto.createHmac('sha256', secret);
hmac.update(body);
const expectedSignature = hmac.digest('hex');

if (receivedSignature !== expectedSignature) {
  throw new Error('Invalid signature');
}

return $json;
```

### 3. Process the Payload

The payload structure:

```json
{
  "event_type": "message_create",
  "relay": {
    "version": 1,
    "source": "discord",
    "bot_called": true,
    "matched_rule": "prefix:!bot"
  },
  "timestamp": "2025-01-15T10:30:00.000Z",
  "guild": {
    "id": "123456789012345678",
    "name": "My Server"
  },
  "channel": {
    "id": "234567890123456789",
    "name": "general",
    "type": 0
  },
  "message": {
    "id": "345678901234567890",
    "content": "!bot summarize this",
    "clean_content": "summarize this",
    "created_at": "2025-01-15T10:30:00.000Z",
    "attachments": []
  },
  "author": {
    "id": "456789012345678901",
    "username": "user",
    "display_name": "User"
  }
}
```

### 4. Reply to Discord (Optional)

Use n8n's **Discord** node or **HTTP Request** node to send messages back:

- **Discord Node**: Configure with bot token, use "Send Message" action
- **HTTP Request**: `POST https://discord.com/api/v10/channels/{channel.id}/messages`

## Testing

### Test Bot Trigger

In your Discord server:
- Type `!bot hello` (or your configured prefix)
- Or mention the bot: `@YourBot hello`

Check the logs to verify:
1. Bot received the message
2. Payload was formatted correctly
3. Request was sent to n8n
4. n8n received the webhook

### Verify Payload Format

The bot logs include debug information. Check logs for:
- "Bot was called" messages
- "Successfully sent payload to n8n" confirmations
- Any error messages

## Troubleshooting

### Bot doesn't respond

- Check that Message Content Intent is enabled in Discord Developer Portal
- Verify bot is in the server and has proper permissions
- Check logs for connection errors

### n8n not receiving webhooks

- Verify `N8N_WEBHOOK_URL` is correct and accessible
- Check network connectivity between bot and n8n
- Review bot logs for HTTP errors
- If using Docker, ensure containers can communicate (same network)

### HMAC verification fails

- Ensure `RELAY_SHARED_SECRET` matches in both bot and n8n
- Check that n8n Code node is computing HMAC correctly
- Verify headers are being read correctly in n8n

## Deployment on Mac Mini

Since you're building on a different machine:

### Option A: Using Docker Compose (Recommended)

1. **Transfer the project to Mac Mini:**
   ```bash
   # From your development machine
   scp -r . user@mac-mini:/path/to/discord-relay/
   ```

2. **On Mac Mini, ensure `config.env` exists:**
   ```bash
   cd /path/to/discord-relay
   # The bot will auto-create config.env from template on first run
   # Or manually copy: cp config.env.example config.env
   ```

3. **Start with docker-compose:**
   ```bash
   docker-compose up -d
   ```

4. **Configure via Web UI:**
   - Open browser to `http://mac-mini-ip:3001`
   - Fill in all configuration values
   - Click "Save Configuration"
   - Restart: `docker-compose restart discord-relay`

### Option B: Using Docker Image

1. **Build the image locally:**
   ```bash
   docker build -t discord-relay .
   ```

2. **Save the image:**
   ```bash
   docker save discord-relay -o discord-relay.tar
   ```

3. **Transfer to Mac Mini:**
   ```bash
   scp discord-relay.tar user@mac-mini:/path/to/destination/
   ```

4. **On Mac Mini, load the image:**
   ```bash
   docker load -i discord-relay.tar
   ```

5. **Edit `config.env` on Mac Mini** (or use web UI):
   ```bash
   # Edit config.env with your values directly, or use web UI
   nano config.env  # or use any text editor
   ```

6. **Run the container:**
   ```bash
   docker run -d \
     --name discord-relay \
     --restart unless-stopped \
     -p 3001:3001 \
     -v $(pwd)/config.env:/app/config.env:rw \
     discord-relay
   ```

7. **Configure via Web UI** at `http://mac-mini-ip:3001` if needed

## Project Structure

```
discord-relay/
├── src/
│   ├── index.js      # Entry point, Discord client setup
│   ├── config.js     # Environment configuration
│   ├── relay.js      # Webhook POST with HMAC and retries
│   ├── filters.js    # Bot trigger detection
│   ├── payload.js    # Payload formatting
│   ├── logger.js     # Winston logging
│   └── webui.js      # Web UI server
├── webui/
│   └── index.html    # Web UI interface
├── config.env        # Main configuration file (edit this! - auto-created from template)
├── config.env.example # Configuration template (committed to git)
├── Dockerfile        # Container definition
├── docker-compose.yml # Docker Compose config
└── package.json      # Dependencies
```

## License

MIT
