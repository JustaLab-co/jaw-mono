#!/usr/bin/env bash
# Runs one jaw command against the run's throwaway home and saves stdout, stderr
# and the exit code as evidence. {SELLER} in any argument becomes the seller URL.
# Usage: drive.sh <run-dir> <head|base> <name> <jaw args...>
set -uo pipefail
RUN=$1 WHICH=$2 NAME=$3; shift 3; . "$RUN/run.env"
BIN_VAR=BIN_$WHICH; BIN=${!BIN_VAR}
args=(); for a in "$@"; do args+=("${a//\{SELLER\}/$SELLER}"); done
OUT=$RUN/evidence/$WHICH/$NAME
HOME=$RUN/work/home-$WHICH "$BIN" "${args[@]}" >"$OUT.out" 2>"$OUT.err"
echo $? >"$OUT.code"
echo "$WHICH/$NAME exit $(cat "$OUT.code")"
