import json

from openai import OpenAI

from app.core.config import settings

client = OpenAI(api_key=settings.openai_api_key)
MODEL = settings.openai_model


def call_tool(system: str, user_content, tool: dict) -> dict:
    """Forces a single function-tool call and returns its parsed arguments dict."""
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
        tools=[tool],
        tool_choice={"type": "function", "function": {"name": tool["function"]["name"]}},
    )
    message = response.choices[0].message
    if not message.tool_calls:
        raise ValueError("OpenAI did not return a tool call")
    return json.loads(message.tool_calls[0].function.arguments)
