"""Domain APIRouters for the AI Bridge control plane (Wave 3B Track A).

Each submodule exposes one factory, ``create_<domain>_router(ctx)``, that
builds an ``APIRouter`` bound to the shared ``ControlContext`` (see
``_context.py``). This package intentionally imports no router submodule at
top level: ``control.app`` imports the factories lazily inside
``create_app()`` (after the app module is fully loaded), and each router
module imports the module-level names it needs from ``control.app``.
"""
from __future__ import annotations
