#!/bin/bash -xe
# This script is executed automatically when the server is first started.
# User: root.

# Sample: add ssh public keys from your https://launchpad.net account.
# See https://launchpad.net/~<your account name>/+editsshkeys 
#sudo -Hu ubuntu ssh-import-id <your account name>
# Or you can do that manually, writing to /home/ubuntu/.ssh/authorized_keys

# Tune TCP kernel settings. The values didnt help much, but just in case.
#cat >> /etc/sysctl.conf <<"EOF"
#net.ipv4.tcp_mem  = 10000   15000  30000
#net.ipv4.tcp_wmem = 1024    1024   65536
#net.ipv4.tcp_rmem = 1024    1024   65536
#EOF
#sysctl -p

# Install latest stable node.js
add-apt-repository ppa:chris-lea/node.js
apt-get update
apt-get install -y nodejs npm

# Write our client code.
sudo -u ubuntu tee -a /home/ubuntu/client.js > /dev/null <<"EOF"
<%=client.js%>
EOF

# Write Upstart job.
cat > /etc/init/client.conf <<"EOF"
    start on runlevel [2345]

    respawn
    respawn limit 10 5 # max 10 times within 5 seconds

    setuid ubuntu
    chdir /home/ubuntu
    limit nofile 100000 100000

    exec node client.js
EOF

# The upstart job will launch our client and keep it alive.
# Output is written to /var/log/upstart/client.log
mkdir /var/log/upstart
initctl reload-configuration
start client
