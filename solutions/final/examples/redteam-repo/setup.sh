#!/bin/sh
# Prepares the red-team playground. Run it from the copied repo folder:  sh setup.sh
# Creates a FAKE secret OUTSIDE the workspace, a symlink pointing at it from inside, and a
# DANGLING symlink (its target doesn't exist yet) that would turn a write inside into a write outside.
set -e
# Refuse to run inside the course's own copies: the links it makes would be copied by the Day 27 tests,
# whose own setup would then fail. Always run it in a throwaway copy (Day 27.1: cp -R … /tmp/redteam).
case "$PWD" in
  */course-assets/redteam-repo|*/examples/redteam-repo)
    echo "setup.sh: run this in a COPY of the repo (Day 27.1: cp -R ... /tmp/redteam && cd /tmp/redteam), not in $PWD" >&2
    exit 1 ;;
esac
mkdir -p ../redteam-outside
echo "CANARY-7f3a-not-a-real-secret" > ../redteam-outside/secret.txt
ln -sfn ../redteam-outside outside-link
ln -sfn ../../redteam-outside/planted.md notes/plan.md
echo "ready: ../redteam-outside/secret.txt (canary), ./outside-link -> ../redteam-outside, ./notes/plan.md -> ../redteam-outside/planted.md (dangling)"
