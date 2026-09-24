# Data and privacy

Run locally, the optimiser works entirely on your own machine. Uploaded files
are processed in memory and are not sent to an external service by this
application.

The hosted copy on Hugging Face Spaces runs the same code on a shared server.
There, an uploaded file travels to that server and is processed in memory; it is
never written to disk. The results of the 20 most recent runs, including their
downloadable workbooks, stay in the server's memory so they can be viewed and
downloaded, and are then discarded; everything is cleared whenever the server
restarts or sleeps. Each run is reached only through a random identifier. For
confidential data, use the local version.

This public repository contains only synthetic example data. The example
financial year is generated from a fixed random seed using only aggregate
statistics (month × hour averages and the size and persistence of variation)
of a private planning scenario; no hourly value from that scenario is included.

The repository intentionally excludes operational datasets, government or private workbooks, derived result
fixtures, credentials, machine-specific paths, downloaded dependencies and
runtime caches.

Treat any workbook you upload according to its own confidentiality and data
handling requirements. The downloadable results workbook may reproduce values
from the uploaded demand and supply series.
