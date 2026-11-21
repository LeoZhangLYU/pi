# Agent Team System

A sophisticated multi-agent coordination system with hierarchical architecture, enabling intelligent task distribution and execution across three layers: Main Coordinator, Managers, and Executors.

## Features

- **3-Tier Architecture**: Main → Managers → Executors
- **Multi-LLM Support**: OpenAI GPT-4, Anthropic Claude
- **Dynamic Agent Creation**: Create agents on-demand
- **Task Management**: Automatic task distribution and tracking
- **REST API**: Complete HTTP API for external integration
- **WebSocket Support**: Real-time updates and streaming
- **Event System**: Observable architecture with EventEmitter
- **Tool Validation**: JSON Schema validation for robustness

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# Start server
npm start
```

## API Endpoints

- `GET /api/status` - System status
- `GET /api/team` - Team overview
- `POST /api/chat` - Send message to Main
- `GET /api/tasks/active` - Active tasks
- `WebSocket /ws` - Real-time updates

## Project Structure

```
src/
├── core/           # Core classes (Agent, TeamManager)
├── llm/            # LLM clients (OpenAI, Anthropic)
├── tools/          # Tool implementations
├── api/            # REST API and WebSocket
└── storage/        # Data persistence

prompts/            # Agent system prompts
data/               # Runtime data
```

## Version History

- **v2.0** - Production release with P0 optimizations
- **v1.0** - Initial independent system

## License

MIT

## Development

```bash
# Development mode with hot reload
npm run dev

# Run with Docker
docker-compose up -d
```

## Documentation

- [OPTIMIZATION_V2.md](./OPTIMIZATION_V2.md) - System optimization details
- [README.md](./README.md) - This file
