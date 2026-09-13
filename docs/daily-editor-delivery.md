# Daily editor delivery

Production starts daily at 03:00 Europe/Berlin. The prepared draft waits at
editor_delivery until the scheduler releases it at 05:00 Europe/Berlin.
The scheduler ticks every minute; network transfer takes additional time.
Both winter and summer time are resolved at runtime, without a restart.

The Drive folder includes draft.mp4 with burned captions, captions.srt using
the same measured audio timeline, thumbnail, actual narration and scene notes,
and credits.json. The editor returns final.mp4 to this folder.

Daily preparation retries failed work after 15 minutes and reuses an existing
run instead of starting another while it is active. Waiting for the delivery
slot or editor is a successful preparation outcome. Upload-only failures are
retried separately, including after restart. Completed uploads are reused.
Late drafts are handed off on the next delivery tick after 05:00.

The Verify editor delivery workflow checks the running production service and
the real Drive folder. Its optional produce input prepares or recovers today's
episode. It never approves editor_review or a publish gate.

Provider outages can still delay delivery. A 03:00 preparation start provides
two hours of lead time; it is not a guarantee against prolonged outages.
