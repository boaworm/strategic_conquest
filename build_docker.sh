#!/bin/bash
set -e
docker build -f Dockerfile.train -t sc-train .
echo "Built sc-train"
