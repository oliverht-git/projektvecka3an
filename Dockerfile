FROM mcr.microsoft.com/openjdk/jdk:21-ubuntu
VOLUME /tmp
ARG JAVA_OPTS
ENV JAVA_OPTS=$JAVA_OPTS
COPY projektvecka3an.jar projektvecka3an.jar
EXPOSE 3006
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar projektvecka3an.jar"]
# For Spring-Boot project, use the entrypoint below to reduce Tomcat startup time.
#ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -Djava.security.egd=file:/dev/./urandom -jar projektvecka3an.jar"]
