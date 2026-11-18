#!/bin/bash
# Restart opencode's background service once no claude-native turn is running under it, so a rebuilt plugin
# loads without killing a live turn. Run detached from the service: systemd-run --user scripts/restart-when-idle.sh
LOG=${LOG:-$HOME/.local/state/opencode-claude-native/restart.log}
mkdir -p "$(dirname "$LOG")"
svc=$(systemctl --user show -p MainPID --value opencode-service.service)
echo "$(date -Is) waiting; service pid=$svc" >>"$LOG"
idle=0
for _ in $(seq 1 1440); do  # give up after ~2 h
  busy=$(pgrep -P "$svc" -f "stream-json" | wc -l)
  if [ "$busy" -eq 0 ]; then idle=$((idle + 1)); else idle=0; fi
  if [ "$idle" -ge 3 ]; then
    # Anything started from an opencode shell (vllm, llama.cpp, dev servers) lives in the service's cgroup and dies
    # with it. Refuse unless FORCE=1.
    cg=$(systemctl --user show -p ControlGroup --value opencode-service.service)
    servers=$(for p in $(cat "/sys/fs/cgroup$cg/cgroup.procs" 2>/dev/null); do
      [ "$p" = "$svc" ] && continue
      a=$(tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null); grep -qE "vllm|llama-server|sglang| serve |http.server|uvicorn" <<<"$a" && echo "$p ${a:0:120}"
    done)
    if [ -n "$servers" ] && [ "${FORCE:-0}" != 1 ]; then
      echo "$(date -Is) NOT restarting: these would die with the service (move them out, or FORCE=1):" >>"$LOG"
      echo "$servers" >>"$LOG"
      exit 1
    fi
    systemctl --user restart opencode-service.service
    sleep 8
    echo "$(date -Is) restarted: $(systemctl --user is-active opencode-service.service) pid=$(systemctl --user show -p MainPID --value opencode-service.service)" >>"$LOG"
    exit 0
  fi
  sleep 5
done
echo "$(date -Is) gave up: service never idle" >>"$LOG"
