import json

from openai import OpenAI

from app.core.config import settings

client = OpenAI(api_key=settings.openai_api_key)
MODEL = settings.openai_model


class OpenAIToolError(RuntimeError):
    """Raised when a forced tool call can't be completed — the underlying API request failed,
    no tool call came back, or its arguments weren't parseable JSON. Collapsing every failure
    mode into one typed exception lets callers that have a safe degraded path (e.g. the
    identity check falling back to 'uncertain' + human review) catch a single specific type
    instead of a bare Exception, without swallowing genuinely unexpected bugs."""


def call_tool(system: str, user_content, tool: dict) -> dict:
    """Forces a single function-tool call and returns its parsed arguments dict.

    Raises OpenAIToolError on any failure so callers can decide whether to degrade
    gracefully or propagate."""
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            tools=[tool],
            tool_choice={"type": "function", "function": {"name": tool["function"]["name"]}},
        )
    except Exception as exc:  # noqa: BLE001 - openai raises many error types; normalize them all
        raise OpenAIToolError(f"OpenAI request failed: {exc}") from exc

    message = response.choices[0].message
    if not message.tool_calls:
        raise OpenAIToolError("OpenAI did not return a tool call")
    try:
        return json.loads(message.tool_calls[0].function.arguments)
    except (json.JSONDecodeError, TypeError) as exc:
        raise OpenAIToolError(f"OpenAI returned unparseable tool arguments: {exc}") from exc
