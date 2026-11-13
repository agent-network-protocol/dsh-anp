# End to end scenarios

Real DSH + DeepSeek scenarios and user UI actors are implemented here.
E02 compares the real model-selected Markdown result with an independent hash
of the running Service Agent's deployed public catalog; no expected response or
hash is supplied in the model task.
See [the acceptance instructions](../README.md). Missing planned cases are listed by the runner and cannot produce a passing full result.

The implemented E01 journey prepares an isolated published identity as a fixture,
then sends only a natural-language read task to an actual DSH Agent running
DeepSeek. Assertions require successful model-selected protocol calls, a live
catalog result, and matching versions in the answer. Fixture registration uses
the deterministic user manager; this does not cover GUI identity creation or
write approval. Those journeys remain separate required cases.

The model and API origin are read from the protected match-service configuration
(`AWIKI_DEEPSEEK_CONFIG_FILE` may select an explicit file). Only the configured
model/base URL are read; `DEEPSEEK_API_KEY` remains a task-process credential.
The current API origin is adapted to DeepSeek's Messages endpoint. The runner
does not persist the key or fall back to another provider. Session logs exist
only in the owning temporary DSH home and are removed after cleanup.

E02 asks the real model for a precise version/language/document and verifies the
actual returned document. E03 uses the shipped Web profile and Chromium: the
model waits for the actual once-only approval dialog, the user actor approves
through that dialog, then the model creates and independently reads the post.
The exact request history must show a consumed once grant and no permanent
grant. The remote post, quota and identity are cleaned before the private home
is removed. Browser login URLs and factor inputs are never printed or traced.
