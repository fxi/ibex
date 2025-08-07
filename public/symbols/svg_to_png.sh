#!/bin/bash
for svg in *.svg; do
  base="${svg%.svg}"
  rsvg-convert -w 24 -h 24 -b transparent "$svg" -o "${base}.png"
done
