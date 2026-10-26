# Biteon AI Review

Local chat and code review. The website, Ollama, and the Qwen models run in Docker. Code stays on the machine.

## What you need

- Docker and the Docker Compose plugin
- About 20GB of free RAM to run the 32B model
- About 35GB of free disk for the first download

The first start downloads three Qwen Coder models:

| Model | Size | Use |
| --- | --- | --- |
| `qwen2.5-coder:32b-instruct-q4_K_M` | 19GB | Default review model. `qwen:security-audit` uses these same weights. |
| `qwen2.5-coder:14b` | 9GB | Faster review when 32B is too slow. |
| `qwen2.5-coder:7b` | 5GB | Quick answers and short files. |

Only the model you select is loaded into RAM.

## Install

Install Docker on Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
```

Copy this folder onto the machine, then start the stack:

```bash
cd "Biteon AI Review"
chmod +x start.sh
./start.sh
```

The first run waits while the models download. Watch that step with:

```bash
docker compose logs -f model-init
```

`qwen-model-init` exits with code 0 when the models are ready. That container is not meant to stay running. `qwen-ollama` and `qwen-ui` stay up.

The site listens on `127.0.0.1:8787` on this machine only. It is not reachable from the internet.

On your laptop, run this in a terminal and leave that terminal open:

```bash
ssh -L 8787:127.0.0.1:8787 root@212.132.71.99
```

Then open http://127.0.0.1:8787. Before the page opens, the site shows that command with **Copy** and **OK**. Press Copy to put the command on the clipboard, then press OK to enter the site. Close the terminal and the site can no longer be reached.

## Use

1. Choose a model in the **Model** field.
2. Open a project folder on the left.
3. Pick a skill on the right and choose **Allow and run**.
4. Or type a question at the bottom and press **Send**.

A folder review uses the first 8 source files. Secret files such as `.env` and private keys are not shown and are not sent to the model.

### Skills

| Skill | What it does |
| --- | --- |
| security-audit | Security review. This one runs the review command. |
| bug-review | Logic bugs and missing error handling. |
| performance-review | Slow or wasteful code. |
| test-gaps | Behavior that has no test. |
| explain-code | Plain-language walkthrough of the file. |
| refactor-plan | A small cleanup that keeps the same behavior. |

The **+** icon saves a new skill. A saved skill uses whichever model is selected. The download icon installs another Ollama model by name, for example `qwen2.5-coder:7b`.

After a review, **Download report** saves a Markdown file in the browser. **Save in project** writes it to `qwen-reviews/` inside the selected project.

## If Ollama is already installed on the host

`./start.sh` refuses to start a second copy when something is already listening on port 11434. Use the host instead:

```bash
docker compose -f docker-compose.host.yml up -d --build
```

To start the full Docker stack anyway:

```bash
FORCE_STACK=1 ./start.sh
```

## Stop

```bash
docker compose stop
```

`docker compose down` removes the containers and keeps the downloaded models in the `ollama-data` volume.
