UUID := whoosh@eshanagarwal05.github.io

.PHONY: all check extension-zip clean

all: extension-zip

check:
	python3 -m py_compile backend/whoosh-backend.py
	python3 -m py_compile backend/whoosh-input-proxy.py
	bash -n backend/install.sh
	bash -n backend/uninstall.sh
	python3 -m json.tool extension/metadata.json >/dev/null

extension-zip: check
	mkdir -p dist
	cd extension && zip -9 -r ../dist/$(UUID).zip extension.js extension-core.js touchscreen.js fourfinger.js metadata.json

clean:
	rm -f dist/$(UUID).zip
	rm -rf backend/__pycache__
