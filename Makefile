PYTHON ?= python3
DOCS_MD := $(filter-out docs/README.md docs/README-template.md, $(wildcard docs/*.md))

docs/README.md: $(DOCS_MD) tools/update-docs-readme.py
	$(PYTHON) tools/update-docs-readme.py

.PHONY: docs
docs: docs/README.md
