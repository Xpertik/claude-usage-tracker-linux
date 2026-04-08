UUID = claude-usage-tracker@xpertik.com
SRC_DIR = gnome-extension
OUT_DIR = upload-ego
ZIP_FILE = $(OUT_DIR)/$(UUID).zip

SOURCES = \
	$(SRC_DIR)/metadata.json \
	$(SRC_DIR)/extension.js \
	$(SRC_DIR)/prefs.js \
	$(SRC_DIR)/stylesheet.css

SCHEMA_XML = $(wildcard $(SRC_DIR)/schemas/*.gschema.xml)
PO_FILES = $(wildcard $(SRC_DIR)/po/*.po)
LOCALES = $(patsubst $(SRC_DIR)/po/%.po,%,$(PO_FILES))

.PHONY: pack clean

pack: clean $(ZIP_FILE)

$(ZIP_FILE): $(SOURCES) $(SCHEMA_XML) $(PO_FILES)
	@mkdir -p $(OUT_DIR)/schemas
	@# Copy source files to output root
	@cp $(SOURCES) $(OUT_DIR)/
	@# Copy schema XML only (no compiled gschemas)
	@cp $(SCHEMA_XML) $(OUT_DIR)/schemas/
	@# Compile locales from .po files
	@for lang in $(LOCALES); do \
		mkdir -p $(OUT_DIR)/locale/$$lang/LC_MESSAGES; \
		msgfmt $(SRC_DIR)/po/$$lang.po -o $(OUT_DIR)/locale/$$lang/LC_MESSAGES/$(UUID).mo; \
	done
	@# Create ZIP with files at root level
	@cd $(OUT_DIR) && zip -r $(UUID).zip \
		metadata.json extension.js prefs.js stylesheet.css \
		schemas/ locale/
	@# Remove loose files, keep only the ZIP
	@rm -rf $(OUT_DIR)/metadata.json $(OUT_DIR)/extension.js \
		$(OUT_DIR)/prefs.js $(OUT_DIR)/stylesheet.css \
		$(OUT_DIR)/schemas $(OUT_DIR)/locale
	@echo "Package ready: $(ZIP_FILE)"

clean:
	@rm -rf $(OUT_DIR)
