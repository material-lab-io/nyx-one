---
name: perhit-intake
description: "Route incoming WhatsApp messages about Perhitsiksha (education NGO) to Priya the PM. Handles donation queries, student enrollment, website issues, social media, partnership requests, and general NGO inquiries."
metadata: {"clawdbot":{"emoji":"🎓"}}
---

# Perhitsiksha Intake — WhatsApp → Priya

When a WhatsApp message is about Perhitsiksha, route it to Priya (the PM) who will handle it.

## Trigger Detection

Activate this skill when an incoming message contains **any** of these signals:

**Explicit keywords:**
- perhitsiksha, "perihit siksha", "perhit", "vikas setu", "vikassetu"
- "ngo", "foundation", "scholarship", "education support", "donate to"

**Implicit intents** (when message context is clearly about the NGO):
- donating / contributing / CSR / 80G / tax exemption
- student enrollment / admission / "my child"
- website issues (perhitsiksha.org)
- "saw your post", "instagram", social media questions about the org
- volunteering / mentoring / becoming a mentor
- partnership / collaboration with the foundation
- Any follow-up in an ongoing conversation already identified as perhit-related

**Do NOT activate for:**
- Generic "education" talk with no NGO context
- Messages clearly about other orgs or personal education queries

---

## What to Do

### Step 1 — Acknowledge the sender immediately

Reply on WhatsApp **before** forwarding. Keep it warm and quick:

```
Hi! Thanks for reaching out about Perhitsiksha 🎓

Someone from our team will be in touch with you shortly.
For urgent matters you can also visit perhitsiksha.org
```

Adapt language to match what the sender used (Hindi or English).

**Hindi version (if they wrote in Hindi):**
```
नमस्ते! परहित शिक्षा फाउंडेशन से जुड़ने के लिए धन्यवाद 🎓

हमारी टीम जल्द ही आपसे संपर्क करेगी।
```

### Step 2 — Classify the intent

Pick the best-fit category:

| Intent | Examples |
|--------|---------|
| `donation` | Want to donate, CSR, 80G receipt, contribute funds |
| `enrollment` | Enroll child, admission, apply for scholarship |
| `volunteer` | Become mentor, volunteer at centre |
| `partnership` | Corporate tie-up, collaboration, joint event |
| `website` | Site not loading, broken page, feedback on website |
| `social` | Questions about Instagram, "saw your post", content |
| `general` | General info request, unclassified |

### Step 3 — Mail Priya

```bash
gt mail send perhit/crew/priya \
  --subject "WA Inquiry [<INTENT>]: <first 8 words of their message>" \
  --body "$(cat <<'EOF'
## WhatsApp Inquiry

**From:** <sender phone number>
**Intent:** <INTENT category>
**Time:** <approximate time of message>

---

**Their message:**
> <full message text, verbatim>

---

## Suggested Action

<one sentence: what Priya should do — e.g. "Forward to perhitsiksha crew with student details" or "Ask web crew to check the reported URL">

## Routing

| Intent | Who handles |
|--------|------------|
| donation | Reply via WA with bank details + 80G info; cc perhitsiksha crew |
| enrollment | Forward to perhitsiksha crew — they manage student pipeline |
| volunteer/mentor | Forward to perhitsiksha crew |
| partnership | Handle directly or escalate to mayor (Kaushik) |
| website | Forward to web crew with URL/issue details |
| social | Forward to content crew |
| general | Handle directly with a WA reply |
EOF
)"
```

Fill in the actual values from the conversation. The `--body` above is the template — replace every `<...>` with real content.

---

## Priya's Response Loop

After Priya acts (her crew resolves the issue), she will nudge nyx back:

```bash
gt nudge nyx_one/crew/nyx "Reply to WA <phone>: <resolution message>"
```

When that nudge arrives, send the resolution message back to the original sender on WhatsApp.

---

## Privacy

- Never share the sender's phone number in any public channel
- Only forward to Priya via `gt mail` (not nudge — this must be durable)
- Do not log full messages in GT bead titles (summary only)

---

## Examples

**Donor inquiry:**
> "Hi, I want to donate to Perhitsiksha. How do I do it?"

→ Acknowledge → classify `donation` → mail Priya with full message + suggestion: "Reply with bank details and 80G form link from website."

**Enrollment:**
> "Mera beta class 9 mein hai, kya aap uski madad kar sakte ho? Humari financial situation thodi mushkil hai."

→ Acknowledge in Hindi → classify `enrollment` → mail Priya: "Forward to perhitsiksha crew with parent's number. Student in class 9, financial hardship."

**Website issue:**
> "Your website perhitsiksha.org isn't loading properly on mobile."

→ Acknowledge → classify `website` → mail Priya: "Forward to web crew to check mobile rendering."
