"""Single source of truth for the EZLog version.

Both the CLI (`cli.py`) and the web UI (`ezlog.py`) read this, so the version
can never drift between them again.
"""

__version__ = "2.0.0"
