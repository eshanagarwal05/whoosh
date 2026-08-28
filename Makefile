UUID := whoosh@eshanagarwal05.github.io
SCHEMA_DIR := extension/schemas

.PHONY: all check extension-zip clean

all: extension-zip

check:
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
	cd extension && zip -9 -r ../dist/$(UUID).zip extension.js extension-core.js touchscreen.js fourfinger.js mouse.js prefs.js metadata.json schemas

clean:
	rm -f dist/$(UUID).zip
	rm -f $(SCHEMA_DIR)/gschemas.compiled
	rm -rf backend/__pycache__
