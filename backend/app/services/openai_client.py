import json

from openai import OpenAI

from app.core.config import settings
from app.services import ai_cache

client = OpenAI(api_key=settings.openai_api_key)
MODEL = settings.openai_model

# Scoring the same resume twice has to produce the same score, or HR can't defend a
# screening decision and a re-upload silently moves a candidate between buckets. Left
# unset, the API samples at temperature 1.0, which is why it did exactly that.
#
# 0.0 makes the model take its highest-probability token at every step instead of sampling
# from the distribution. It is the right default for every caller here: all of them are
# extraction or judgement tasks (parse this resume, score it, does this face match, did
# this answer cover the concept) where a different answer on the same input is a defect,
# not variety. A generative caller that genuinely wants a fresh take passes its own value.
DETERMINISTIC_TEMPERATURE = 0.0

# Best-effort on OpenAI's side rather than a guarantee, and only has an effect at all when
# sampling: it pins the sampler so repeated requests draw identically. Temperature 0 above
# is what actually does the work here; this costs nothing and removes one more source of
# drift for any caller that raises the temperature.
DEFAULT_SEED = 11


class OpenAIToolError(RuntimeError):
    """Raised when a forced tool call can't be completed — the underlying API request failed,
    no tool call came back, or its arguments weren't parseable JSON. Collapsing every failure
    mode into one typed exception lets callers that have a safe degraded path (e.g. the
    identity check falling back to 'uncertain' + human review) catch a single specific type
    instead of a bare Exception, without swallowing genuinely unexpected bugs."""


def call_tool(
    system: str,
    user_content,
    tool: dict,
    temperature: float = DETERMINISTIC_TEMPERATURE,
    seed: int | None = DEFAULT_SEED,
    cache_key: str | None = None,
    cache_kind: str = "tool",
    timeout: float | None = None,
) -> dict:
    """Forces a single function-tool call and returns its parsed arguments dict.

    Deterministic by default — see DETERMINISTIC_TEMPERATURE. Pass a higher `temperature`
    only where re-running the same input *should* give something different.

    `cache_key` makes a call exactly reproducible rather than merely stable: temperature 0
    is not a determinism guarantee from the API, so a caller whose answer must not move
    between identical requests (scoring, resume parsing) passes a hash of its own inputs
    and gets the first answer back forever. Opt-in, because most callers here are keyed on
    something that is never byte-identical twice anyway — a frame, a voice clip.

    Raises OpenAIToolError on any failure so callers can decide whether to degrade
    gracefully or propagate.

    `timeout` (seconds) bounds this one request; left as None it keeps the OpenAI client's
    own default, so existing callers are unaffected. No retry is attempted here — a caller
    that wants one must do it itself, deliberately, since every retry is another paid call."""
    if cache_key:
        cached = ai_cache.get(cache_key)
        if cached is not None:
            return cached

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            tools=[tool],
            tool_choice={"type": "function", "function": {"name": tool["function"]["name"]}},
            temperature=temperature,
            **({"seed": seed} if seed is not None else {}),
            timeout=timeout,
        )
    except Exception as exc:  # noqa: BLE001 - openai raises many error types; normalize them all
        raise OpenAIToolError(f"OpenAI request failed: {exc}") from exc

    message = response.choices[0].message
    if not message.tool_calls:
        raise OpenAIToolError("OpenAI did not return a tool call")
    try:
        parsed = json.loads(message.tool_calls[0].function.arguments)
    except (json.JSONDecodeError, TypeError) as exc:
        raise OpenAIToolError(f"OpenAI returned unparseable tool arguments: {exc}") from exc

    if cache_key:
        ai_cache.put(cache_key, cache_kind, parsed)
    return parsed
