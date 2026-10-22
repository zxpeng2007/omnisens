# Host-side unit tests for the SDK-independent parts of the firmware.
#   make -C firmware/test run
CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Werror -Wno-unused-parameter -fsanitize=address,undefined -fno-omit-frame-pointer

TESTS = test_core test_hid test_store

all: $(TESTS)

test_core: test_core.c ../src/omni_core.c ../src/omni_core.h vectors.inc
	$(CC) $(CFLAGS) -o $@ test_core.c ../src/omni_core.c -lm

test_hid: test_hid.c ../src/hid_parser.c ../src/hid_parser.h ../src/report_descs.h
	$(CC) $(CFLAGS) -o $@ test_hid.c ../src/hid_parser.c

test_store: test_store.c ../src/config_store.c ../src/config_store.h ../src/omni_core.c
	$(CC) $(CFLAGS) -o $@ test_store.c ../src/config_store.c ../src/omni_core.c -lm

.PHONY: all run clean
run: $(TESTS)
	./test_core
	./test_hid
	./test_store

clean:
	rm -f $(TESTS)
