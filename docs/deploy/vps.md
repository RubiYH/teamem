# VPS Deployment

This is a minimal deployment outline for running the Teamem server on a VPS.

## Requirements

- Docker and Docker Compose
- A domain or reachable host address
- TLS termination, usually through a reverse proxy
- A persistent volume for SQLite data

## Deploy

```bash
git clone https://github.com/RubiYH/teamem.git
cd teamem
cp .env.example .env
# Set TEAMEM_JWT_SECRET and production server settings.
docker compose up --build -d
```

Set at least:

- `TEAMEM_JWT_SECRET`
- `TEAMEM_DB_PATH`
- `PORT`

Put the server behind HTTPS before sharing it with teammates.

## Verify

```bash
curl https://your-teamem-host.example/health
```

Then give teammates the server URL and onboarding instructions.
