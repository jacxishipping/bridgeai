#!/usr/bin/env python3
"""Serve the Wave 5C WebRTC E2E harness on http://127.0.0.1:5173/.

Static files come from this directory (analysis/). In addition, GET
/staging-token returns {"token": "<staging admin token>"} read from the
0600 file at ~/workspace/tmp/staging-admin-token (env STAGING_TOKEN_FILE
overrides the path). The token is never logged and never written anywhere
by this server; the harness fetches it same-origin on load and fills its
password field, so no human or agent ever has to paste or print the token
to run the browser test. The token is sent by the harness only as an
X-Admin-Token header to the staging plane, exactly as if it had been
pasted into the field.

Binds 127.0.0.1 only. Stop with Ctrl-C. Local test tooling only — not
part of the shipped product.
"""
from __future__ import annotations

import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN_FILE = Path(
    os.environ.get(
        "STAGING_TOKEN_FILE",
        str(Path.home() / "workspace" / "tmp" / "staging-admin-token"),
    )
)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/staging-token":
            try:
                token = TOKEN_FILE.read_text().strip()
            except OSError:
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"token file unavailable")
                return
            body = json.dumps({"token": token}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        # Keep the access log, but never log request bodies or the token.
        super().log_message(fmt, *args)


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    server = ThreadingHTTPServer(
        ("127.0.0.1", 5173), partial(Handler, directory=str(here))
    )
    print("serving harness on http://127.0.0.1:5173/ (Ctrl-C to stop)")
    server.serve_forever()
