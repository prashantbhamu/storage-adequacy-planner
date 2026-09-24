---
title: Storage Adequacy Planner
emoji: 🔋
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Plan how storage lifts the tightest hours of a power system
---

# Storage Adequacy Planner

Upload a month or a financial year of hourly demand and available supply,
describe a storage resource, and see hour by hour how it should charge and
discharge, and how much it lifts the tightest hours. Choose **or try the
example year** to explore with synthetic data.

Uploaded files are processed in memory on this server for the run and are not
stored. For confidential data, run the tool on your own computer instead:
source and instructions are at
[github.com/prashantbhamu/storage-adequacy-planner](https://github.com/prashantbhamu/storage-adequacy-planner).

Heavy calculations run one at a time; if someone else's run is in progress,
yours waits its turn and the progress card says so.
