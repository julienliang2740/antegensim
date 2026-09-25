"""Empyrean prototype backend package.

Module map (see docs/INTERFACES.md):
  schemas  shared Pydantic models (frozen contract)
  config   defaults and the ASSUMPTIONS registry (frozen contract)
  world    authoritative world state and rules
  skills   block language parser/compiler/interpreter
  context  per-agent knowledge and decision packets
  model    the only model boundary (providers behind adapters)
  storage  files, checkpoints, continuations
  runner   worker thread, status machine, turn orchestration
  api      FastAPI routes
  main     entry point
"""

from .schemas import SCHEMA_VERSION

__version__ = SCHEMA_VERSION
