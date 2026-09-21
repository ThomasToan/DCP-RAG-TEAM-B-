#!/bin/bash
# Run a script with the WSL venv's Python. Lets Node call it as: wsl --cd <project> -- bash scripts/py.sh <script> <args>
# (the project path has a space in it, so we pass relative paths and set the directory with --cd)
exec "$HOME/dcp-venv/bin/python" "$@"
