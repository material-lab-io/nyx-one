# OpenClaw Multi-Tenant Deployment

Run multiple isolated OpenClaw gateways on a single server using Docker Compose.

## Quick Start

```bash
# 1. Build the image
./build-image.sh

# 2. Provision a tenant
./provision-tenant.sh my-tenant --anthropic-key sk-ant-xxx

# 3. Add to compose
./add-to-compose.sh my-tenant 18789

# 4. Start
docker compose up -d my-tenant

# 5. Link WhatsApp
./link-whatsapp.sh my-tenant
```

## Scripts

| Script | Purpose |
|--------|---------|
| `build-image.sh` | Build the OpenClaw Docker image |
| `provision-tenant.sh` | Create a new tenant directory structure |
| `add-to-compose.sh` | Add a tenant to docker-compose.yml |
| `remove-tenant.sh` | Remove a tenant completely |
| `list-tenants.sh` | List all tenants and their status |
| `link-whatsapp.sh` | Link WhatsApp for a tenant |
| `tenant-status.sh` | Detailed status for a tenant |

## Directory Structure

```
/data/
├── openclaw/           # This directory (orchestration)
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── templates/
│   └── *.sh scripts
├── my-tenant/          # Per-tenant data
│   ├── .openclaw/
│   │   ├── openclaw.json
│   │   ├── credentials/
│   │   └── agents/
│   └── secrets.env
└── shared/             # Shared across all tenants
    ├── skills/
    └── plugins/
```

## Tenant Isolation

Each tenant runs in a separate container with:
- **Separate credentials** - Own WhatsApp/Discord sessions
- **Separate config** - Own model settings, agents
- **Resource limits** - 2 CPU cores, 2GB RAM max
- **Network isolation** - No inter-container communication
- **Security hardening** - Dropped capabilities, no privilege escalation

## Common Tasks

### Add a new tenant
```bash
./provision-tenant.sh acme-corp --anthropic-key sk-ant-xxx
./add-to-compose.sh acme-corp 18790
docker compose up -d acme-corp
./link-whatsapp.sh acme-corp
```

### Check status
```bash
./list-tenants.sh
./tenant-status.sh acme-corp
```

### View logs
```bash
docker compose logs -f acme-corp
```

### Restart a tenant
```bash
docker compose restart acme-corp
```

### Remove a tenant
```bash
./remove-tenant.sh acme-corp
```

## Port Assignment

Tenants are assigned sequential ports starting from 18789:
- tenant-1: 18789
- tenant-2: 18790
- tenant-3: 18791
- ...

The `provision-tenant.sh` script auto-assigns ports if not specified.
