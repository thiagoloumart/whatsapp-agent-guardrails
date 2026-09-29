# WhatsApp Agent Guardrails

**A default-deny gate between your AI agents and WhatsApp: every robot can only message the groups it was explicitly allowed to. Anything else is stopped before it leaves.**

## The problem

Once a business has more than a handful of automations on WhatsApp (AI SDRs, alert bots, report senders, scripts written by coding agents), one bug or one wrong ID is enough to send an internal alert, a lead's data or a half-written message to the wrong group. Often that group has clients in it. The WhatsApp API will send whatever it receives, so nothing stands in the way.

## What it does

A tiny proxy (about 200 lines of Node, no dependencies) that sits in front of the [Evolution API](https://github.com/EvolutionAPI/evolution-api) and inspects every outgoing message:

| Situation | What happens |
|---|---|
| Message to a person (DM) | Passes |
| Robot sending to a group on its allowlist | Passes |
| Robot sending to any other group | **Blocked.** The text is rerouted to the owner's private chat with a warning, so nothing is lost |
| Audio/image to a group that is not allowed | **Dropped**, and the owner gets an alert |
| Script that does not identify itself | Cannot post in groups at all |
| *Optional router mode* | Only one "router" agent sends directly. Everything else is held and handed to it to approve and re-send, which works as a human-in-the-loop or agent-in-the-loop checkpoint |

Each robot identifies itself with an `X-Wa-Robot` header. Rules live in `allowlist.json` and reload the moment you save the file, with no restart.

**Shadow mode first.** With `"enforce": false`, nothing is blocked: it only logs what it *would* have blocked. You can run it for a few days, fix the allowlist, then turn enforcement on.

## In production

It has run in front of my own WhatsApp automations since June 2026. In the first 3 months:

- about **3,300** outgoing messages checked, from **35** different robots and scripts;
- **239** messages stopped before reaching the wrong group and rerouted to me;
- **80** messages held for approval by the router agent;
- **90** calls from old scripts to a renamed WhatsApp instance rescued, instead of failing silently.

## Run it

```bash
cp allowlist.example.json allowlist.json   # set your robots, groups and owner number
npm test                                   # 9 scenario tests against a fake WhatsApp API
npm start                                  # listens on 127.0.0.1:8088
```

Then point your nginx (or your scripts) at the guard instead of straight at the Evolution API. Only `/message/send*` is inspected. Every other call passes through untouched.

Every decision is written to `logs/guard.log` as one JSON line: allowed, blocked, rerouted or held, plus which robot sent it and where it was going.

## How it was built

AI-native: I wrote the rules for my own fleet of automations, directed coding agents to build it, and tightened it with what the logs showed. Code comments are in Portuguese.

---

Thiago Lourenço Martins · [LinkedIn](https://www.linkedin.com/in/thiago-lourenco-martins) · [loumart.com.br](https://loumart.com.br)
