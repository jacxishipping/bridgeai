"""Local AI Agent using Ollama and AI Bridge.

Runs 100% locally and privately without external cloud API keys.
Ollama (e.g. Llama 3, Mistral, Qwen) controls your computer fleet through AI Bridge.

The agent runs a real multi-turn tool loop (finding I-02): the model may
call tools, the results are executed and fed back into the conversation,
and the loop repeats until the model answers or the turn cap is reached.
A final synthesis answer is always produced from the tool results — raw
tool output is never the final answer.

Approval-gated results (finding I-04) are reported honestly: a result with
status ``needs_approval`` means the operation is QUEUED for human approval
and has NOT run; the agent must say so, not claim success.

Requirements:
    Ollama running on http://localhost:11434 (ollama run llama3.2)
    pip install ollama

Usage:
    export AI_BRIDGE_URL="https://your-control-plane.example"
    export AI_BRIDGE_TOKEN="your-admin-or-session-token"
    python ollama_local_agent.py "Check free memory on ubuntu and screenshot windows-pc"
"""
import json
import os
import sys

# Ensure local package can be imported if running from repo
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "src")))

from ai_bridge import AIBridgeClient
from _bridge_config import describe_result, is_pending_approval, require_bridge_url

MAX_TURNS = 8
MODEL = "llama3.2"


def execute_tool_calls(client, tool_calls):
    """Execute one round of tool calls; return (results, pending_approval)."""
    results = []
    pending = False
    for tc in tool_calls:
        fn = tc.get("function", {})
        fn_name = fn.get("name")
        fn_args = dict(fn.get("arguments", {}) or {})
        dev = fn_args.pop("device", None)
        print(f"    - Calling {fn_name} on device '{dev}'...")
        try:
            res = client.execute(fn_name, device=dev, args=fn_args)
        except Exception as exc:
            res = {"ok": False, "status": "failed", "error": str(exc)}
            print(f"      Tool failed: {exc}")
        if is_pending_approval(res):
            pending = True
            print(f"      [!] AWAITING HUMAN APPROVAL (approval_id={res.get('approval_id')}) — not executed.")
        else:
            print(f"      Result: {str(res)[:150]}...")
        results.append({"role": "tool", "content": describe_result(res)})
    return results, pending


def run_ollama_agent(prompt, max_turns=MAX_TURNS):
    """Multi-turn loop: model -> tools -> results fed back -> final answer."""
    try:
        import ollama
    except ImportError:
        print("[!] Install the official ollama package: pip install ollama")
        sys.exit(1)

    bridge_url = require_bridge_url()
    token = os.environ.get("AI_BRIDGE_TOKEN") or os.environ.get("AI_BRIDGE_ADMIN_TOKEN", "")

    client = AIBridgeClient(base_url=bridge_url, token=token)
    devices = client.list_devices()
    print(f"[*] Connected devices: {[d.get('name') for d in devices]}")

    # Convert AI Bridge tools to Ollama function format
    tools_openai = client.get_tools(format="openai")

    messages = [{"role": "user", "content": prompt}]
    print(f"\n[>] Instructing Local Ollama: '{prompt}'...")

    for turn in range(1, max_turns + 1):
        print(f"--- Turn {turn} (Calling Ollama) ---")
        response = ollama.chat(model=MODEL, messages=messages, tools=tools_openai)
        msg = response.get("message", {})
        tool_calls = msg.get("tool_calls") or []

        if not tool_calls:
            answer = msg.get("content") or "(no answer)"
            print("\n[=] Final Answer from Ollama:\n", answer)
            return answer

        # Keep the assistant's tool-call message in history, then feed
        # the executed results back so the model can use them (I-02).
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": tool_calls})
        print(f"[*] Ollama decided to call {len(tool_calls)} tool(s):")
        tool_results, pending = execute_tool_calls(client, tool_calls)
        messages.extend(tool_results)
        if pending:
            messages.append({
                "role": "user",
                "content": (
                    "Note: at least one tool call is awaiting human approval and has "
                    "NOT been executed. Do not claim it succeeded; tell the user it "
                    "is pending approval."
                ),
            })

    print("[!] Reached maximum conversation turns without a final answer.")
    return None


def main():
    prompt = sys.argv[1] if len(sys.argv) > 1 else "List all files in workspace on windows-pc"
    run_ollama_agent(prompt)


if __name__ == "__main__":
    main()
