# Kiro

T3 Code runs [Kiro CLI](https://kiro.dev/cli/) as an agent, using your Kiro sign-in, models,
agents, MCP servers, and credits.

## Set up Kiro

1. Install Kiro CLI on the machine running the T3 Code server. T3 Code supports Kiro CLI 2.19
   or newer.
2. Run `kiro-cli login` on that machine.
3. Open **Settings → Providers**, add Kiro, and enable it.

If `kiro-cli` is not on the server's `PATH`, set Kiro's **Binary path**.

## Several Kiro accounts

Add one Kiro provider instance per account. Give each instance its own `KIRO_HOME` and
`XDG_DATA_HOME` in the instance's environment settings, then sign that account in once from a
terminal with the same variables:

```sh
KIRO_HOME=~/.kiro-accounts/work/home XDG_DATA_HOME=~/.kiro-accounts/work/data kiro-cli login
```

Each instance then uses its own login, credits, and session history.

## Models, effort, and modes

The model picker lists the models your Kiro account offers. Models that support thinking effort
show an **Effort** option with the levels Kiro accepts for that model. **Mode** selects one of
Kiro's agents, such as its planner.

T3 Code learns which models support effort, and Kiro's agents, by opening a Kiro session once
after Kiro is installed or updated, or when its model list changes. Choose **Refresh models** in
the provider's settings to check again.

## Credits and usage

The composer's context meter shows how full the conversation's context is and the credits the
thread has used, including credits used by its subagents. **Usage → Limits** shows your monthly
credit allowance; it updates after each turn. The Usage page includes Kiro history from every
instance's `KIRO_HOME`, priced at Kiro's overage rate.

## Subagents

When Kiro delegates work to a crew of subagents, each one appears as its own subagent thread with
its tools and answer.

## Permission modes

Kiro enforces these itself:

- **Supervised** asks before tools Kiro does not trust by default, such as commands and edits.
- **Auto-accept edits** lets Kiro read and edit files without asking, and asks before commands
  and other tools.
- **Full access** trusts every tool.

Changing the permission mode restarts the Kiro session for that thread, keeping the conversation.
