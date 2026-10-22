export PATH := $(CURDIR)/.local-runtime/node_modules/.bin:$(PATH)

.PHONY: setup gen install start status log stop uninstall

setup:
	PATH="$(PATH)" npm run chat:setup

gen:
	@PATH="$(PATH)" npm --silent run chat:gen

install:
	PATH="$(PATH)" npm run chat:install

start:
	PATH="$(PATH)" npm run chat:start

status:
	PATH="$(PATH)" npm run chat:status

log:
	@PATH="$(PATH)" npm --silent run chat:logs -- $(LOG_ARGS)

stop:
	PATH="$(PATH)" npm run chat:stop

uninstall:
	PATH="$(PATH)" npm run chat:uninstall
