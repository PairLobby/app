# PairLobby relay container

```sh
docker build --build-arg PAIRLOBBY_VERSION=<version> -t pairlobby-relay deploy/relay
docker run --rm -p 8790:8790 -v pairlobby-data:/data -e PAIRLOBBY_CREATE_TOKEN=<token> pairlobby-relay
```

Behind a load balancer at `https://pairlobby.example.com`:

```sh
docker run -p 8790:8790 \
  -e PAIRLOBBY_PUBLIC_URL=https://pairlobby.example.com \
  -e PAIRLOBBY_TRUSTED_PROXY_HEADER=x-forwarded-for \
  -e PAIRLOBBY_CREATE_TOKEN_FILE=/run/secrets/create-token \
  -e PAIRLOBBY_BACKUP=s3://<bucket>/pairlobby \
  -e AWS_REGION=<region> \
  pairlobby-relay
```

To let people log in once with the team token (`pairlobby setup https://pairlobby.example.com --login`), add:

```sh
  -e PAIRLOBBY_LOGIN_MODE=token \
  -e PAIRLOBBY_DISCOVERY_NAME="Example Corp PairLobby" \
  -e PAIRLOBBY_LOGIN_HELP="Ask your team lead for the PairLobby team token." \
```

Run exactly one copy: the rooms live in one SQLite file. Stop the old container before starting the new one; with `PAIRLOBBY_BACKUP` the new one restores what the old one backed up on stop.

Check a deployed relay from outside:

```sh
PAIRLOBBY_CREATE_TOKEN=<token> npx -y @pairlobby/local-server@<version> check https://pairlobby.example.com
```

It creates one test room, joins it, sends and reads a message, and deletes it. Every setting is in [GUIDE.md](../../GUIDE.md#running-the-relay-as-a-service-or-in-a-container).
