export PATH := $(CURDIR)/.local-runtime/node_modules/.bin:$(PATH)

.PHONY: setup gen install start status logs stop uninstall

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

logs:
	PATH="$(PATH)" npm run chat:logs

stop:
	PATH="$(PATH)" npm run chat:stop

uninstall:
	PATH="$(PATH)" npm run chat:uninstall
