BIN_DIR := bin
SERVER_DIR := server
SERVER_BIN := peertopeervideo-server

.PHONY: build build-android run clean

build:
	mkdir -p $(BIN_DIR)
	cd $(SERVER_DIR) && go build -o ../$(BIN_DIR)/$(SERVER_BIN)

build-android:
	mkdir -p $(BIN_DIR)
	cd $(SERVER_DIR) && GOOS=android GOARCH=arm64 go build -o ../$(BIN_DIR)/$(SERVER_BIN)-android

run:
	cd $(SERVER_DIR) && go run .

clean:
	rm -rf $(BIN_DIR)
