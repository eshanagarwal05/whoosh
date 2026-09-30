UUID := whoosh@eshanagarwal05.github.io
SCHEMA_DIR := extension/schemas

.PHONY: all check extension-zip clean

all: extension-zip

check:
	python3 -m py_compile extension/tab-target.py
	python3 -m unittest discover -s tests -p 'test_*.py'
	node --check extension/extension-core.js
	node --check extension/extension.js
	node --check extension/tab-target.js
	node --check extension/resize.js
	node --check extension/resize-geometry.js
	node tests/test-resize.cjs
	node tests/test-core.cjs
	node tests/test-pinch-timing.cjs
	node tests/test-helper-lifecycle.cjs
	python3 -m py_compile backend/whoosh-backend.py
	python3 -m py_compile backend/whoosh-input-proxy.py
	python3 -m py_compile backend/whoosh-mouse-proxy.py
	bash -n backend/install.sh
	bash -n backend/uninstall.sh
	python3 -m json.tool extension/metadata.json >/dev/null
	glib-compile-schemas --strict --dry-run $(SCHEMA_DIR)

extension-zip: check
	mkdir -p dist
	glib-compile-schemas --strict $(SCHEMA_DIR)
	cd extension && zip -9 -r ../dist/$(UUID).zip extension.js extension-core.js tab-target.js tab-target.py touchscreen.js fourfinger.js mouse.js resize.js resize-geometry.js prefs.js metadata.json schemas

clean:
	rm -f dist/$(UUID).zip
	rm -f $(SCHEMA_DIR)/gschemas.compiled
	rm -rf backend/__pycache__ extension/__pycache__ tests/__pycache__
