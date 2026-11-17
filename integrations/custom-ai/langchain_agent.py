"""LangChain Integration for AI Bridge Computer Fleet.

Exposes AI Bridge device tools as LangChain StructuredTools so you can use
LangGraph, CrewAI, AutoGen, or LangChain agents to control your computers.

Requirements:
    pip install langchain langchain-openai langchain-core

Usage:
    export OPENAI_API_KEY="sk-..."
    export AI_BRIDGE_URL="https://your-control-plane.example"
    export AI_BRIDGE_TOKEN="your-token"
    python langchain_agent.py
"""
import os
import sys

# Ensure local package can be imported if running from repo
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "src")))

from ai_bridge import AIBridgeClient
from _bridge_config import describe_result, require_bridge_url

# JSON Schema type -> Python type for building pydantic arg models (I-03).
_JSON_TYPE_MAP = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


def build_args_schema(tool_name: str, parameters: dict):
    """Build a pydantic model from a tool's JSON Schema parameters.

    Returns None when the tool declares no parameters, so callers can
    omit args_schema in that case. Unknown/missing types fall back to
    ``str`` with the schema description preserved where present.
    """
    from pydantic import Field, create_model

    properties = (parameters or {}).get("properties", {}) or {}
    if not properties:
        return None
    required = set((parameters or {}).get("required", []) or [])
    fields = {}
    for prop_name, prop_spec in properties.items():
        spec = prop_spec if isinstance(prop_spec, dict) else {}
        py_type = _JSON_TYPE_MAP.get(str(spec.get("type", "string")).lower(), str)
        default = ... if prop_name in required else None
        fields[prop_name] = (
            py_type,
            Field(default=default, description=spec.get("description", "")),
        )
    return create_model(f"{tool_name}Args", **fields)


def create_ai_bridge_langchain_tools(client: AIBridgeClient):
    """Dynamically converts AI Bridge tool specifications into LangChain StructuredTools."""
    try:
        from langchain_core.tools import StructuredTool
    except ImportError:
        print("[!] Error: 'langchain-core' is required. Install via: pip install langchain-core")
        return []

    tools_raw = client.get_tools(format="raw")
    lc_tools = []

    for t in tools_raw:
        name = t["name"]
        description = t["description"]
        params = t.get("parameters", {})
        args_schema = build_args_schema(name, params)

        # Create tool closure
        def make_func(tool_name):
            def run_tool(**kwargs):
                device = kwargs.pop("device", None)
                try:
                    res = client.execute(tool=tool_name, device=device, args=kwargs)
                except Exception as exc:
                    return describe_result({"ok": False, "status": "failed", "error": str(exc)})
                # Honest reporting (I-04): approval-gated results are
                # labelled PENDING APPROVAL by describe_result, never
                # summarised as a successful execution.
                return describe_result(res)
            return run_tool

        lc_tools.append(
            StructuredTool.from_function(
                func=make_func(name),
                name=name,
                description=description,
                args_schema=args_schema,
            )
        )

    return lc_tools


def main():
    bridge_url = require_bridge_url()
    token = os.environ.get("AI_BRIDGE_TOKEN") or os.environ.get("AI_BRIDGE_ADMIN_TOKEN", "")

    client = AIBridgeClient(base_url=bridge_url, token=token)
    lc_tools = create_ai_bridge_langchain_tools(client)

    print(f"[*] Created {len(lc_tools)} LangChain StructuredTools from AI Bridge fleet.")
    for t in lc_tools[:5]:
        print(f"    - {t.name}: {t.description[:60]}...")

    print("\n[+] These tools can be passed directly to create_react_agent or CrewAI Agent(tools=lc_tools).")


if __name__ == "__main__":
    main()

